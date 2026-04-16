import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import {
  StoreganiseApiService,
  SgUnit,
} from '../storeganise/storeganise-api.service';
import { UnitSyncHandler } from '../handlers/unit-sync.handler';
import { SyncLogService } from './sync-log.service';
import { parseSmartcubeId, extractUserInfo } from '../common/utils';

export interface SiteSyncEvent {
  type:
    | 'progress'
    | 'unit-success'
    | 'unit-error'
    | 'unit-retry'
    | 'complete'
    | 'stopped';
  jobId: string;
  unitId?: string;
  unitName?: string;
  current: number;
  total: number;
  succeeded?: number;
  failed?: number;
  error?: string;
  attempt?: number;
  maxAttempts?: number;
  /** unit-success 시 DB 가 실제 변경됐는지 여부 */
  changed?: boolean;
  /** unit-success 지만 smartcube_id 가 없는 등 이유로 실제 sync 를 건너뛴 경우 */
  skipped?: boolean;
  /** unit-success 후 DB 기준 유닛 상태 (클라이언트가 그리드 카드 실시간 업데이트용) */
  areaCode?: string;
  showBoxNo?: number;
  groupCode?: string;
  postState?: 'occupied' | 'blocked' | 'available';
  postOverlocked?: boolean;
  postNonRevenue?: boolean;
  postUserName?: string;
  postUserPhone?: string;
}

interface SiteSyncJob {
  id: string;
  officeCode: string;
  subject: Subject<SiteSyncEvent>;
  running: boolean;
  stopRequested: boolean;
  total: number;
  current: number;
  succeeded: number;
  failed: number;
}

export interface SiteSyncGroupUnit {
  showBoxNo: number;
  unitId: string;
  name: string;
  state: string;
  overlocked: boolean;
  /** STG unit.state='blocked' (운영자 수동 차단 — 비매출 사용자). STG view 에서만 true */
  nonRevenue?: boolean;
  ownerName: string;
  /** DB 기준 view 에서만 채워짐 (호버 툴팁용) */
  userName?: string;
  userPhone?: string;
}

export interface SiteSyncUnitGroup {
  groupCode: string;
  units: SiteSyncGroupUnit[];
}

interface SiteSyncUnitFilter {
  groupCode: string;
  showBoxNos: number[];
}

// 순차 처리: 병렬화는 setPtiUserEnableAllForGroup 등에서 교차 그룹 lock 을
// 유발해 deadlock 이 발생. 순차 처리하면 근본적으로 deadlock 없음.
const CONCURRENCY = 1;

/**
 * STG `unit.state` → dashboard 의 3-state 어휘로 정규화.
 *
 * 호호락 정책 (docs/SmartCube_데이터매핑.md:103-115):
 *   - `occupied`            → 사용중
 *   - `blocked`             → 차단
 *   - 그 외 (available, reserved, pre_completed, completed, archived 등)
 *                           → 빈칸 (호호락은 move-in completed 이전/move-out
 *                              완료 이후 상태를 관리하지 않음)
 *
 * 화이트리스트 방식이라 STG 가 새 state 를 추가해도 보수적으로 빈칸 처리.
 */
export function canonicalizeUnitState(
  raw: string | undefined,
): 'occupied' | 'blocked' | 'available' {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'occupied') return 'occupied';
  if (s === 'blocked') return 'blocked';
  return 'available';
}

@Injectable()
export class SiteSyncService {
  private readonly logger = new Logger(SiteSyncService.name);
  private readonly jobs = new Map<string, SiteSyncJob>();

  /** DEBUG: 남은 강제 실패 횟수 (0이면 정상 동작) */
  static __debugFailCount = 0;

  constructor(
    private readonly sgApi: StoreganiseApiService,
    private readonly unitSyncHandler: UnitSyncHandler,
    private readonly syncLog: SyncLogService,
  ) {}

  /**
   * STG 기준으로 지점의 전체 유닛 목록을 그룹별로 반환.
   *
   * overlock 판정:
   *   rental.customFields.smartcube_lockStatus === 'overlocked'
   *
   * active rental 전체를 bulk 조회 후 siteId 로 필터링해 rentalId → overlock
   * 인덱스를 구축한다. 유닛별 개별 rental fetch 대비 수백 배 빠름.
   */
  async getStgUnits(
    officeCode: string,
  ): Promise<{ groups: SiteSyncUnitGroup[] }> {
    const siteId = await this.sgApi.getSiteIdByOfficeCode(officeCode);
    if (!siteId) return { groups: [] };

    const [allUnits, allRentals] = await Promise.all([
      this.sgApi.getUnitsForSite(siteId),
      this.sgApi.getActiveRentals(),
    ]);

    const rentalInfoById = new Map<
      string,
      { overlocked: boolean; futureStart: boolean }
    >();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (const rental of allRentals) {
      if (rental.siteId !== siteId) continue;
      const cf = (rental.customFields ?? {}) as Record<string, unknown>;
      const startDate = rental.startDate;
      const futureStart = !!(
        startDate && new Date(`${startDate}T00:00:00`) > today
      );
      rentalInfoById.set(rental.id, {
        overlocked: cf.smartcube_lockStatus === 'overlocked',
        futureStart,
      });
    }

    const groupMap = new Map<string, SiteSyncGroupUnit[]>();
    for (const unit of allUnits) {
      const parsed = parseSmartcubeId(unit.customFields?.smartcube_id);
      if (!parsed) continue;

      const rentalId = (unit as { rentalId?: string }).rentalId;
      const rentalInfo = rentalId ? rentalInfoById.get(rentalId) : undefined;
      const canonical = canonicalizeUnitState(unit.state);

      // DB 모델과 표시 일치시키기:
      // - unit.state=blocked 는 '차단(비매출 사용자)' 로 별도 표시 (nonRevenue=true)
      //   기존에는 rental 없으면 빈칸으로 squash 했으나, 운영자가 STG 에서 명시적으로
      //   차단한 유닛이라 그리드에서 구분돼야 함.
      // - rental 이 미래 시작 → DB useState=3 (차단) 로 표시
      let displayState: 'occupied' | 'blocked' | 'available' = canonical;
      const nonRevenue = canonical === 'blocked';
      if (rentalInfo?.futureStart) displayState = 'blocked';

      const overlocked =
        canonical === 'occupied' && rentalInfo ? rentalInfo.overlocked : false;

      const unitInfo: SiteSyncGroupUnit = {
        showBoxNo: parsed.showBoxNo,
        unitId: unit.id,
        name: unit.name,
        state: displayState,
        overlocked,
        ownerName: '',
      };
      if (nonRevenue) unitInfo.nonRevenue = true;

      const existing = groupMap.get(parsed.groupCode);
      if (existing) existing.push(unitInfo);
      else groupMap.set(parsed.groupCode, [unitInfo]);
    }

    const groups = Array.from(groupMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([groupCode, units]) => ({
        groupCode,
        units: units.sort((a, b) => a.showBoxNo - b.showBoxNo),
      }));

    return { groups };
  }

  /**
   * 호호락 DB 기준으로 지점의 전체 유닛 목록을 그룹별로 반환.
   *
   * state 매핑:
   *   useState=1 → occupied
   *   useState=2 → available
   *   useState=3 → blocked
   *
   * overlock 판정:
   *   isOverlocked=1
   */
  async getDbUnits(
    officeCode: string,
  ): Promise<{ groups: SiteSyncUnitGroup[] }> {
    const prefix = 'strh' + officeCode;
    const result = await this.syncLog.queryBoxMasterForGrid(prefix);

    const groupMap = new Map<string, SiteSyncGroupUnit[]>();
    for (const row of result) {
      // areaCode = strh + officeCode(3자리) + groupCode(4자리) → slice(7)
      const groupCode = row.areaCode.slice(7);
      const state: 'occupied' | 'blocked' | 'available' =
        row.useState === 1
          ? 'occupied'
          : row.useState === 3
            ? 'blocked'
            : 'available';
      const unit: SiteSyncGroupUnit = {
        showBoxNo: row.showBoxNo,
        unitId: '', // DB 에는 STG unit.id 없음
        name: String(row.showBoxNo),
        state,
        overlocked: row.isOverlocked === 1,
        ownerName: '',
        userName: row.userName || '',
        userPhone: row.userPhone || '',
      };
      // tblUserTypeDesc 기준 UserType='X' 비매출 유닛 (운영/청소/임시/강제퇴실).
      // tblSiteUserInfo 또는 tblPTIUserInfo 중 하나라도 X 로 매칭되면 true.
      if (row.isNonRevenue === 1) unit.nonRevenue = true;
      const existing = groupMap.get(groupCode);
      if (existing) existing.push(unit);
      else groupMap.set(groupCode, [unit]);
    }

    const groups = Array.from(groupMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([groupCode, units]) => ({
        groupCode,
        units: units.sort((a, b) => a.showBoxNo - b.showBoxNo),
      }));

    return { groups };
  }

  isRunning(officeCode: string): boolean {
    for (const job of this.jobs.values()) {
      if (job.officeCode === officeCode && job.running) return true;
    }
    return false;
  }

  stopSync(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !job.running) return false;
    job.stopRequested = true;
    this.logger.log(`[siteSync] Stop requested for job ${jobId}`);
    return true;
  }

  startSync(
    officeCode: string,
    groupCodes?: string[],
    unitFilter?: SiteSyncUnitFilter,
    unitFilters?: SiteSyncUnitFilter[],
  ): string {
    if (this.isRunning(officeCode)) {
      throw new Error(`Site sync already running for office ${officeCode}`);
    }

    const jobId = `ss-${Date.now()}`;
    const subject = new Subject<SiteSyncEvent>();
    const job: SiteSyncJob = {
      id: jobId,
      officeCode,
      subject,
      running: true,
      stopRequested: false,
      total: 0,
      current: 0,
      succeeded: 0,
      failed: 0,
    };
    this.jobs.set(jobId, job);

    void this.runSync(job, groupCodes, unitFilter, unitFilters).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[siteSync] Fatal error: ${message}`);
      },
    );

    return jobId;
  }

  getJobStream(jobId: string): Observable<SiteSyncEvent> | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return job.subject.asObservable();
  }

  private async runSync(
    job: SiteSyncJob,
    groupCodes?: string[],
    unitFilter?: SiteSyncUnitFilter,
    unitFilters?: SiteSyncUnitFilter[],
  ): Promise<void> {
    const { officeCode } = job;

    const siteId = await this.sgApi.getSiteIdByOfficeCode(officeCode);
    if (!siteId) {
      job.subject.next({
        type: 'complete',
        jobId: job.id,
        current: 0,
        total: 0,
        succeeded: 0,
        failed: 0,
        error: `No site found for officeCode ${officeCode}`,
      });
      job.subject.complete();
      job.running = false;
      return;
    }

    const allUnits = await this.sgApi.getUnitsForSite(siteId);
    let units = allUnits.filter((unit) => !!unit.customFields?.smartcube_id);

    // unitFilters (복수) — 여러 그룹의 개별 유닛 + groupCodes 합산
    if (
      (unitFilters && unitFilters.length > 0) ||
      (groupCodes && groupCodes.length > 0)
    ) {
      // 허용 맵: { 'groupCode:showBoxNo': true } + groupCodes 전체
      const allowMap = new Map<string, Set<number> | 'all'>();
      if (groupCodes) {
        groupCodes.forEach((gc) => allowMap.set(gc, 'all'));
      }
      if (unitFilters) {
        unitFilters.forEach((f) => {
          if (allowMap.get(f.groupCode) === 'all') return;
          const existing = allowMap.get(f.groupCode);
          if (existing instanceof Set) {
            f.showBoxNos.forEach((bn) => existing.add(bn));
          } else {
            allowMap.set(f.groupCode, new Set(f.showBoxNos));
          }
        });
      }
      units = units.filter((unit) => {
        const parsed = parseSmartcubeId(unit.customFields?.smartcube_id);
        if (!parsed) return false;
        const entry = allowMap.get(parsed.groupCode);
        if (!entry) return false;
        if (entry === 'all') return true;
        return entry.has(parsed.showBoxNo);
      });
    }
    // 단일 unitFilter (하위 호환)
    else if (
      unitFilter &&
      unitFilter.groupCode &&
      unitFilter.showBoxNos?.length > 0
    ) {
      const showBoxSet = new Set(unitFilter.showBoxNos);
      units = units.filter((unit) => {
        const parsed = parseSmartcubeId(unit.customFields?.smartcube_id);
        return (
          !!parsed &&
          parsed.groupCode === unitFilter.groupCode &&
          showBoxSet.has(parsed.showBoxNo)
        );
      });
    }

    job.total = units.length;

    this.logger.log(
      `[siteSync] Starting sync for office ${officeCode} — ${units.length} units, concurrency=${CONCURRENCY}`,
    );

    // Process in batches of CONCURRENCY
    for (let i = 0; i < units.length; i += CONCURRENCY) {
      if (job.stopRequested) {
        job.subject.next({
          type: 'stopped',
          jobId: job.id,
          current: job.current,
          total: job.total,
          succeeded: job.succeeded,
          failed: job.failed,
        });
        job.subject.complete();
        job.running = false;
        this.logger.log(`[siteSync] Stopped at ${job.current}/${job.total}`);
        return;
      }

      const batch = units.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((unit) => this.syncOneUnit(job, unit)));

      // Emit progress after each batch
      job.subject.next({
        type: 'progress',
        jobId: job.id,
        current: job.current,
        total: job.total,
        succeeded: job.succeeded,
        failed: job.failed,
      });
    }

    job.subject.next({
      type: 'complete',
      jobId: job.id,
      current: job.total,
      total: job.total,
      succeeded: job.succeeded,
      failed: job.failed,
    });
    job.subject.complete();
    job.running = false;

    this.logger.log(
      `[siteSync] Complete — office ${officeCode}: ${job.succeeded} succeeded, ${job.failed} failed`,
    );

    setTimeout(() => this.jobs.delete(job.id), 5 * 60 * 1000);
  }

  private async syncOneUnit(job: SiteSyncJob, unit: SgUnit): Promise<void> {
    const unitId = unit.id;
    const unitName = unit.name || unitId;
    const startTime = Date.now();
    const maxRetries = 3;
    const corrId = randomUUID();
    const parsed = parseSmartcubeId(unit.customFields?.smartcube_id);
    const unitAreaCode = parsed
      ? `strh${job.officeCode}${parsed.groupCode}`
      : null;
    const unitShowBoxNo = parsed?.showBoxNo ?? null;
    const unitOwnerId = unit.ownerId ?? null;
    let ownerName: string | null = null;
    if (unitOwnerId) {
      try {
        const owner = await this.sgApi.getUser(unitOwnerId);
        ownerName = extractUserInfo(owner).userName || null;
      } catch {
        // 사용자 조회 실패해도 sync 자체는 진행
      }
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // DEBUG: 강제 실패 주입
        if (SiteSyncService.__debugFailCount > 0) {
          SiteSyncService.__debugFailCount--;
          throw new Error('[DEBUG] Forced timeout failure on siteSync');
        }

        const result = await this.unitSyncHandler.syncUnit(unit);
        job.succeeded++;
        job.current++;

        // result === null 이면 smartcube_id 미매핑 등으로 syncUnit 이 조기 return.
        // 이 경우 "변경 없음" 이 아니라 "건너뜀" 으로 구분해 운영자 오해 방지.
        const isSkipped = result === null;

        // 그리드 실시간 업데이트용 post-sync 상태 조회.
        // 스킵된 유닛 (smartcube_id 미매핑 / STG blocked) 은 DB 가 변경되지 않았으므로 생략.
        let post: Awaited<ReturnType<typeof this.syncLog.queryUnitStateForGrid>> =
          null;
        if (!isSkipped && unitAreaCode !== null && unitShowBoxNo !== null) {
          try {
            post = await this.syncLog.queryUnitStateForGrid(
              unitAreaCode,
              unitShowBoxNo,
            );
          } catch {
            // post-state 조회 실패해도 sync 성공 자체는 유지 — 그리드만 다음 refresh 때 반영
          }
        }
        const postState: 'occupied' | 'blocked' | 'available' | undefined =
          post
            ? post.useState === 1
              ? 'occupied'
              : post.useState === 3
                ? 'blocked'
                : 'available'
            : undefined;

        job.subject.next({
          type: 'unit-success',
          jobId: job.id,
          unitId,
          unitName,
          current: job.current,
          total: job.total,
          attempt,
          maxAttempts: maxRetries,
          changed: isSkipped ? false : (result?.changed ?? false),
          skipped: isSkipped,
          areaCode: unitAreaCode ?? undefined,
          showBoxNo: unitShowBoxNo ?? undefined,
          groupCode: parsed?.groupCode,
          postState,
          postOverlocked: post ? post.isOverlocked === 1 : undefined,
          postNonRevenue: post ? post.isNonRevenue === 1 : undefined,
          postUserName: post?.userName,
          postUserPhone: post?.userPhone,
        });

        void this.syncLog.add({
          source: 'site-sync',
          eventType: 'unit.synced',
          eventId: job.id,
          correlationKey: corrId,
          businessCode: null,
          areaCode: result?.areaCode ?? null,
          showBoxNo: result?.showBoxNo ?? null,
          userName: result?.userName ?? null,
          stgUserId: result?.stgUserId ?? null,
          stgUnitId: result?.stgUnitId ?? unitId,
          status: 'success',
          attempt,
          maxAttempts: maxRetries,
          durationMs: Date.now() - startTime,
          error: null,
          payload: {
            unitId,
            unitName,
            officeCode: job.officeCode,
            attempt,
            maxAttempts: maxRetries,
          },
        });
        return;
      } catch (err) {
        const errorMsg = (err as Error).message;
        const lower = errorMsg.toLowerCase();
        const isRetryable = [
          'deadlock',
          'timeout',
          'timed out',
          'network_error',
          'econnreset',
          'econnrefused',
          'etimedout',
          '429',
          ' 500',
          ' 502',
          ' 503',
          ' 504',
          'database connection not available',
        ].some((token) => lower.includes(token));

        if (isRetryable && attempt < maxRetries) {
          const backoff = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
          this.logger.warn(
            `[siteSync] Retryable error on ${unitName}, retry ${attempt}/${maxRetries} in ${backoff}ms`,
          );
          job.subject.next({
            type: 'unit-retry',
            jobId: job.id,
            unitId,
            unitName,
            current: job.current,
            total: job.total,
            attempt,
            maxAttempts: maxRetries,
            error: errorMsg,
          });
          void this.syncLog.add(
            {
              source: 'site-sync',
              eventType: 'unit.synced',
              eventId: job.id,
              correlationKey: corrId,
              businessCode: null,
              areaCode: unitAreaCode,
              showBoxNo: unitShowBoxNo,
              userName: ownerName,
              stgUserId: unitOwnerId,
              stgUnitId: unitId,
              status: 'error',
              attempt,
              maxAttempts: maxRetries,
              durationMs: Date.now() - startTime,
              error: `[${attempt}/${maxRetries}] ${errorMsg}`,
              payload: {
                unitId,
                unitName,
                officeCode: job.officeCode,
                attempt,
                maxAttempts: maxRetries,
                retrying: true,
              },
            },
            { suppressAlert: true },
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        job.failed++;
        job.current++;

        job.subject.next({
          type: 'unit-error',
          jobId: job.id,
          unitId,
          unitName,
          current: job.current,
          total: job.total,
          error: errorMsg,
          attempt,
          maxAttempts: maxRetries,
        });

        void this.syncLog.add({
          source: 'site-sync',
          eventType: 'unit.synced',
          eventId: job.id,
          correlationKey: corrId,
          businessCode: null,
          areaCode: unitAreaCode,
          showBoxNo: unitShowBoxNo,
          userName: null,
          stgUserId: unitOwnerId,
          stgUnitId: unitId,
          status: 'error',
          attempt,
          maxAttempts: maxRetries,
          durationMs: Date.now() - startTime,
          error: `[${attempt}/${maxRetries}] ${errorMsg}`,
          payload: {
            unitId,
            unitName,
            officeCode: job.officeCode,
            attempt,
            maxAttempts: maxRetries,
          },
        });

        this.logger.warn(`[siteSync] Unit ${unitName} failed: ${errorMsg}`);
        return;
      }
    }
  }
}
