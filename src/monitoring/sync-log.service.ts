import { Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { DatabaseService } from '../database/database.service';
import { SyncLogEntry, DashboardStats } from './monitoring.types';
import { ReplayabilityService } from './replayability.service';
import { FailureAlertService } from './failure-alert.service';

/**
 * DatabaseService의 useUTC:false 설정으로 mssql 드라이버가 이미 KST wall clock을
 * 올바른 UTC instant의 JS Date로 반환한다. 따라서 정상 ISO(Z)를 그대로 직렬화하고
 * 브라우저에서 Intl로 KST 렌더링한다.
 */
function toIsoUtc(date: Date): string {
  return date.toISOString();
}

type LogSearchField =
  | 'workId'
  | 'unitName'
  | 'stgUnitId'
  | 'unitId'
  | 'unitKey'
  | 'userId'
  | 'userPhone'
  | 'userName';

const LOG_SEARCH_FIELDS: LogSearchField[] = [
  'workId',
  'unitName',
  'stgUnitId',
  'unitId',
  'unitKey',
  'userId',
  'userPhone',
  'userName',
];

@Injectable()
export class SyncLogService {
  private readonly logger = new Logger(SyncLogService.name);
  // 허용되는 source 값. SyncLogEntry.source 타입과 일관성 유지.
  // 새 source 추가 시 (예: 'api') 이 배열과 monitoring.types.ts 에 동시에 반영.
  private static readonly SUPPORTED_SOURCES: readonly string[] = [
    'webhook',
    'scheduler',
    'site-sync',
    'user-sync',
    'api',
  ];

  readonly events$ = new Subject<SyncLogEntry>();

  constructor(
    private readonly db: DatabaseService,
    private readonly replayability: ReplayabilityService,
    private readonly failureAlert: FailureAlertService,
  ) {}

  async add(
    entry: Omit<SyncLogEntry, 'id' | 'createdAt'>,
    options?: { suppressAlert?: boolean; throwOnError?: boolean },
  ): Promise<SyncLogEntry | void> {
    const correlationKey =
      entry.correlationKey ?? this.buildCorrelationKey(entry);

    try {
      const result = await this.db.query<{
        id: number;
        createdAt: Date;
        correlationKey: string | null;
        replayedFromLogId: number | null;
        alertSentAt: Date | null;
        alertStatus: string | null;
      }>(
        `INSERT INTO tblSyncLog (source, eventType, eventId, correlationKey, businessCode, areaCode, showBoxNo, userName, stgUserId, stgUnitId, replayedFromLogId, status, attempt, maxAttempts, durationMs, error, payload)
         OUTPUT INSERTED.id, INSERTED.createdAt, INSERTED.correlationKey, INSERTED.replayedFromLogId, INSERTED.alertSentAt, INSERTED.alertStatus
         VALUES (@source, @eventType, @eventId, @correlationKey, @businessCode, @areaCode, @showBoxNo, @userName, @stgUserId, @stgUnitId, @replayedFromLogId, @status, @attempt, @maxAttempts, @durationMs, @error, @payload)`,
        {
          source: entry.source,
          eventType: entry.eventType,
          eventId: entry.eventId,
          correlationKey,
          businessCode: entry.businessCode,
          areaCode: entry.areaCode,
          showBoxNo: entry.showBoxNo,
          userName: entry.userName ?? null,
          stgUserId: entry.stgUserId ?? null,
          stgUnitId: entry.stgUnitId ?? null,
          replayedFromLogId: entry.replayedFromLogId ?? null,
          status: entry.status,
          attempt: entry.attempt ?? null,
          maxAttempts: entry.maxAttempts ?? null,
          durationMs: entry.durationMs,
          error: entry.error,
          payload: entry.payload ? JSON.stringify(entry.payload) : null,
        },
      );

      const inserted = result.recordset[0];
      const fullEntry: SyncLogEntry = {
        ...entry,
        id: inserted.id,
        createdAt: inserted.createdAt,
        correlationKey: inserted.correlationKey ?? correlationKey,
        replayedFromLogId: inserted.replayedFromLogId,
        alertSentAt: inserted.alertSentAt,
        alertStatus: inserted.alertStatus,
      };
      const enriched = this.enrichEntry(fullEntry);
      this.events$.next(enriched);

      if (entry.status === 'error' && !options?.suppressAlert) {
        await this.failureAlert.notifyFinalFailure(enriched);
      }

      return enriched;
    } catch (err) {
      this.logger.error(`Failed to insert sync log: ${(err as Error).message}`);
      if (options?.throwOnError) {
        throw err;
      }
    }
  }

  async getAll(
    limit = 50,
    offset = 0,
    sources?: string[],
    status?: string,
    query?: string,
    searchFields?: string[],
    site?: string,
  ): Promise<{ items: SyncLogEntry[]; total: number }> {
    const validSources = (sources ?? []).filter((s) =>
      SyncLogService.SUPPORTED_SOURCES.includes(s),
    );
    const validStatus = ['success', 'error'].includes(status ?? '')
      ? status
      : undefined;
    const trimmedQuery = query?.trim() ?? '';
    const selectedSearchFields = this.getValidSearchFields(searchFields);

    const whereParts: string[] = [];
    const params: Record<string, unknown> = { limit, offset };

    if (validSources.length > 0) {
      const placeholders = validSources.map((_, idx) => `@source${idx}`);
      validSources.forEach((source, idx) => {
        params[`source${idx}`] = source;
      });
      whereParts.push(`source IN (${placeholders.join(', ')})`);
    }

    if (validStatus) {
      whereParts.push('status = @status');
      params.status = validStatus;
    }

    const trimmedSite = site?.trim();
    if (trimmedSite && /^\d{3}$/.test(trimmedSite)) {
      whereParts.push(`areaCode LIKE 'strh' + @siteCode + '%'`);
      params.siteCode = trimmedSite;
    }

    if (trimmedQuery) {
      params.searchTerm = `%${trimmedQuery}%`;
      const searchClause = this.buildSearchClause(
        selectedSearchFields,
        '@searchTerm',
      );
      if (searchClause) {
        whereParts.push(`(${searchClause})`);
      }
    }

    const whereClause = whereParts.length
      ? `WHERE ${whereParts.join(' AND ')}`
      : '';

    const totalResult = await this.db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM tblSyncLog ${whereClause}`,
      params,
    );

    const itemsResult = await this.db.query<SyncLogEntry>(
      `SELECT TOP(@limit) * FROM (
        SELECT *, ROW_NUMBER() OVER (ORDER BY createdAt DESC) AS rn
        FROM tblSyncLog ${whereClause}
      ) t
      WHERE rn > @offset
      ORDER BY rn`,
      params,
    );

    return {
      items: this.enrichEntries(itemsResult.recordset),
      total: totalResult.recordset[0]?.total ?? 0,
    };
  }

  private getValidSearchFields(fields?: string[]): LogSearchField[] {
    const valid = (fields ?? []).filter((field): field is LogSearchField =>
      LOG_SEARCH_FIELDS.includes(field as LogSearchField),
    );
    return valid.length > 0 ? valid : LOG_SEARCH_FIELDS;
  }

  private buildSearchClause(
    fields: LogSearchField[],
    paramName: string,
  ): string {
    const clauses: string[] = [];

    if (fields.includes('workId')) {
      clauses.push(
        `CAST(id AS NVARCHAR(50)) LIKE ${paramName}`,
        `ISNULL(eventId, '') LIKE ${paramName}`,
        `ISNULL(businessCode, '') LIKE ${paramName}`,
        `ISNULL(correlationKey, '') LIKE ${paramName}`,
      );
    }

    if (fields.includes('unitName')) {
      clauses.push(
        `${this.buildOfficeNameCase()} LIKE ${paramName}`,
        `(${this.buildOfficeNameCase()} + N' #' + ${this.buildUnitNumberExpr()}) LIKE ${paramName}`,
      );
    }

    if (fields.includes('stgUnitId')) {
      clauses.push(`ISNULL(stgUnitId, '') LIKE ${paramName}`);
    }

    if (fields.includes('unitId')) {
      clauses.push(`${this.buildUnitNumberExpr()} LIKE ${paramName}`);
    }

    if (fields.includes('unitKey')) {
      clauses.push(
        `(ISNULL(areaCode, '') + N':' + ISNULL(CAST(showBoxNo AS NVARCHAR(20)), '')) LIKE ${paramName}`,
      );
    }

    if (fields.includes('userId')) {
      clauses.push(`ISNULL(stgUserId, '') LIKE ${paramName}`);
    }

    if (fields.includes('userPhone')) {
      clauses.push(
        `ISNULL(CAST(payload AS NVARCHAR(MAX)), '') LIKE ${paramName}`,
      );
    }

    if (fields.includes('userName')) {
      clauses.push(`ISNULL(userName, '') LIKE ${paramName}`);
    }

    return clauses.join(' OR ');
  }

  private buildOfficeNameCase(): string {
    return `CASE SUBSTRING(ISNULL(areaCode, ''), 5, 3)
      WHEN '001' THEN N'논현점'
      WHEN '002' THEN N'마곡점'
      WHEN '003' THEN N'선릉역점'
      WHEN '004' THEN N'WB 논현'
      WHEN '005' THEN N'WB 선릉역'
      WHEN '006' THEN N'고양점'
      WHEN '007' THEN N'금호점'
      WHEN '008' THEN N'목동점'
      ELSE ISNULL(areaCode, '')
    END`;
  }

  private buildUnitNumberExpr(): string {
    // showBoxNo는 STG unit.name과 동일한 운영자 표시 번호. 단순 문자열화로 충분.
    return `ISNULL(CAST(showBoxNo AS NVARCHAR(20)), '')`;
  }

  async getErrors(limit = 20): Promise<SyncLogEntry[]> {
    const result = await this.db.query<SyncLogEntry>(
      `SELECT TOP(@limit) * FROM tblSyncLog WHERE status = 'error' ORDER BY createdAt DESC`,
      { limit },
    );
    return this.enrichEntries(result.recordset);
  }

  async getById(id: number): Promise<SyncLogEntry | null> {
    const result = await this.db.query<SyncLogEntry>(
      `SELECT TOP 1 * FROM tblSyncLog WHERE id = @id`,
      { id },
    );
    return this.enrichEntries(result.recordset)[0] ?? null;
  }

  /**
   * 예정된 스케줄링 작업 조회 — tblScheduledJob 기반.
   *
   * 기존 tblBoxMaster 상태 추론 방식에서 명시적 job 큐로 전환되면서,
   * dashboard가 보는 데이터도 tblScheduledJob.status='pending'을 직접 읽도록 변경.
   * 이벤트 타입과 보조 메타는 기존 dashboard 포맷(type: 'moveIn'|'moveOut')에 매핑한다.
   */
  async getPendingScheduled(): Promise<
    {
      jobId: number;
      eventType: string;
      type: string;
      status: string;
      areaCode: string;
      showBoxNo: number;
      userName: string;
      userPhone: string;
      stgUserId: string;
      stgUnitId: string;
      scheduledDate: Date;
      attempts: number;
      maxAttempts: number;
      sourceEventType: string | null;
      sourceEventId: string | null;
      correlationKey: string | null;
    }[]
  > {
    const result = await this.db.query<{
      jobId: number;
      eventType: string;
      status: string;
      scheduledAt: Date;
      areaCode: string;
      showBoxNo: number;
      userName: string | null;
      userPhone: string | null;
      userCode: string | null;
      attempts: number;
      maxAttempts: number;
      sourceEventType: string | null;
      sourceEventId: string | null;
      correlationKey: string | null;
      stgUnitId: string | null;
    }>(`
      SELECT
        sj.jobId,
        sj.eventType,
        sj.status,
        sj.scheduledAt,
        sj.areaCode,
        sj.showBoxNo,
        sj.userName,
        sj.userPhone,
        sj.userCode,
        sj.attempts,
        sj.maxAttempts,
        sj.sourceEventType,
        sj.sourceEventId,
        sj.correlationKey,
        (SELECT TOP 1 stgUnitId FROM tblSyncLog
         WHERE areaCode = sj.areaCode AND showBoxNo = sj.showBoxNo AND stgUnitId IS NOT NULL
         ORDER BY createdAt DESC) AS stgUnitId
      FROM tblScheduledJob sj
      WHERE sj.status = 'pending'
      ORDER BY sj.scheduledAt ASC, sj.jobId ASC
    `);

    return result.recordset.map((row) => ({
      jobId: row.jobId,
      eventType: row.eventType,
      type: this.mapScheduleEventToDashboardType(row.eventType),
      status: row.status,
      areaCode: row.areaCode,
      showBoxNo: row.showBoxNo,
      userName: row.userName ?? '',
      userPhone: row.userPhone ?? '',
      stgUserId: row.userCode ?? '',
      stgUnitId: row.stgUnitId ?? '',
      scheduledDate: row.scheduledAt,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      sourceEventType: row.sourceEventType,
      sourceEventId: row.sourceEventId,
      correlationKey: row.correlationKey,
    }));
  }

  /**
   * tblScheduledJob.eventType을 기존 dashboard 카테고리('moveIn'|'moveOut')로 매핑.
   * - moveIn.activate → moveIn
   * - moveOut.block   → moveOut
   */
  private mapScheduleEventToDashboardType(eventType: string): string {
    if (eventType.startsWith('moveIn.')) return 'moveIn';
    if (eventType.startsWith('moveOut.')) return 'moveOut';
    return eventType;
  }

  /** 특정 지점(officeCode 3자리)의 그룹 목록 조회 */
  async getGroupsByOffice(
    officeCode: string,
  ): Promise<{ groupCode: string; unitCount: number }[]> {
    // areaCode = "strh" + officeCode(3자리) + groupCode(4자리)
    const prefix = 'strh' + officeCode; // e.g. "strh001"
    const result = await this.db.query<{
      groupCode: string;
      unitCount: number;
    }>(
      `SELECT SUBSTRING(areaCode, 8, 4) AS groupCode, COUNT(*) AS unitCount
       FROM tblBoxMaster
       WHERE areaCode LIKE @prefix + '%'
       GROUP BY SUBSTRING(areaCode, 8, 4)
       ORDER BY groupCode`,
      { prefix },
    );
    return result.recordset;
  }

  /**
   * 그리드 (지점 단위) 렌더링용 일괄 조회 — areaCode prefix 로 매칭.
   * site-sync.service.getDbUnits 전용.
   */
  async queryBoxMasterForGrid(
    areaCodePrefix: string,
  ): Promise<
    {
      areaCode: string;
      showBoxNo: number;
      useState: number;
      isOverlocked: number;
      userName: string;
      userPhone: string;
      /** 비매출 사용자 여부 — UserTypeDesc 의 'X' 타입 (운영/청소/임시/강제퇴실 등).
       *  tblSiteUserInfo (site 레벨 사용자 마스터) 또는 tblPTIUserInfo (유닛별 게이트 권한)
       *  중 어느 하나라도 UserType='X' 로 매칭되면 비매출로 간주. */
      isNonRevenue: number;
    }[]
  > {
    const result = await this.db.query<{
      areaCode: string;
      showBoxNo: number;
      useState: number;
      isOverlocked: number;
      userName: string;
      userPhone: string;
      isNonRevenue: number;
    }>(
      `SELECT bm.areaCode, bm.showBoxNo,
              ISNULL(bm.useState, 0) AS useState,
              ISNULL(bm.isOverlocked, 0) AS isOverlocked,
              ISNULL(bm.userName, '') AS userName,
              ISNULL(bm.userPhone, '') AS userPhone,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM tblSiteUserInfo su
                  WHERE su.UserType = 'X'
                    AND ((bm.userCode <> '' AND su.UserId = bm.userCode)
                      OR (bm.userPhone <> '' AND su.UserPhone = bm.userPhone))
                ) THEN 1
                WHEN EXISTS (
                  SELECT 1 FROM tblPTIUserInfo pti
                  WHERE pti.AreaCode = bm.areaCode
                    AND pti.showBoxNo = bm.showBoxNo
                    AND pti.UserType = 'X'
                ) THEN 1
                ELSE 0
              END AS isNonRevenue
       FROM tblBoxMaster bm
       WHERE bm.areaCode LIKE @prefix + '%' AND bm.showBoxNo IS NOT NULL
       ORDER BY bm.areaCode, bm.showBoxNo`,
      { prefix: areaCodePrefix },
    );
    return result.recordset;
  }

  /**
   * 단일 유닛의 post-sync DB 상태 조회 — SSE `unit-success` 이벤트에 실려
   * 클라이언트가 그리드 카드를 즉시 갱신하는 데 사용.
   */
  async queryUnitStateForGrid(
    areaCode: string,
    showBoxNo: number,
  ): Promise<{
    useState: number;
    isOverlocked: number;
    userName: string;
    userPhone: string;
    isNonRevenue: number;
  } | null> {
    const result = await this.db.query<{
      useState: number;
      isOverlocked: number;
      userName: string;
      userPhone: string;
      isNonRevenue: number;
    }>(
      `SELECT ISNULL(bm.useState, 0) AS useState,
              ISNULL(bm.isOverlocked, 0) AS isOverlocked,
              ISNULL(bm.userName, '') AS userName,
              ISNULL(bm.userPhone, '') AS userPhone,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM tblSiteUserInfo su
                  WHERE su.UserType = 'X'
                    AND ((bm.userCode <> '' AND su.UserId = bm.userCode)
                      OR (bm.userPhone <> '' AND su.UserPhone = bm.userPhone))
                ) THEN 1
                WHEN EXISTS (
                  SELECT 1 FROM tblPTIUserInfo pti
                  WHERE pti.AreaCode = bm.areaCode
                    AND pti.showBoxNo = bm.showBoxNo
                    AND pti.UserType = 'X'
                ) THEN 1
                ELSE 0
              END AS isNonRevenue
       FROM tblBoxMaster bm
       WHERE bm.areaCode = @areaCode AND bm.showBoxNo = @showBoxNo`,
      { areaCode, showBoxNo },
    );
    return result.recordset[0] ?? null;
  }

  /** 특정 지점+그룹의 유닛 목록 조회 */
  async getUnitsByGroup(
    officeCode: string,
    groupCode: string,
  ): Promise<
    {
      showBoxNo: number;
      userName: string;
      userPhone: string;
      useState: number;
    }[]
  > {
    const areaCode = 'strh' + officeCode + groupCode;
    const result = await this.db.query<{
      showBoxNo: number;
      userName: string;
      userPhone: string;
      useState: number;
    }>(
      `SELECT showBoxNo, ISNULL(userName, '') AS userName, ISNULL(userPhone, '') AS userPhone, useState
       FROM tblBoxMaster
       WHERE areaCode = @areaCode
       ORDER BY showBoxNo`,
      { areaCode },
    );
    return result.recordset;
  }

  async getStats(): Promise<DashboardStats> {
    const result = await this.db.query<{
      lastEventAt: Date | null;
    }>(`
      SELECT
        MAX(createdAt) AS lastEventAt
      FROM tblSyncLog
    `);

    const stats = result.recordset[0];

    return {
      lastEventAt: stats.lastEventAt
        ? toIsoUtc(new Date(stats.lastEventAt))
        : null,
    };
  }

  private enrichEntries(entries: SyncLogEntry[]): SyncLogEntry[] {
    return entries.map((entry) => this.enrichEntry(entry));
  }

  private enrichEntry(entry: SyncLogEntry): SyncLogEntry {
    const correlationKey =
      entry.correlationKey ?? this.buildCorrelationKey(entry);
    const replay = this.replayability.evaluate(entry);
    return {
      ...entry,
      correlationKey,
      replayable: replay.replayable,
      replayReason: replay.replayReason,
    };
  }

  private buildCorrelationKey(entry: Partial<SyncLogEntry>): string | null {
    if (entry.correlationKey) return entry.correlationKey;

    const source = entry.source ?? 'unknown';
    const eventType =
      entry.eventType ??
      this.getString(this.parsePayload(entry.payload)?.type) ??
      'unknown';
    const payload = this.parsePayload(entry.payload);
    const data = payload?.data as Record<string, unknown> | undefined;

    const candidates = [
      this.getString(entry.eventId),
      this.getString(data?.jobId),
      this.getString(data?.unitRentalId),
      this.getString(data?.unitId),
      this.getString(data?.userId),
      this.getString(entry.stgUnitId),
      this.getString(entry.stgUserId),
      entry.areaCode && entry.showBoxNo != null
        ? `${entry.areaCode}:${entry.showBoxNo}`
        : null,
      this.getString(entry.businessCode),
    ];

    const token = candidates.find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    return token ? `${source}:${eventType}:${token}` : null;
  }

  private parsePayload(
    payload: SyncLogEntry['payload'] | undefined,
  ): Record<string, unknown> | null {
    if (!payload) return null;
    if (typeof payload === 'string') {
      try {
        return JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return payload as Record<string, unknown>;
  }

  private getString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }
}
