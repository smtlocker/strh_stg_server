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
  overdue: boolean;
  ownerName: string;
}

export interface SiteSyncUnitGroup {
  groupCode: string;
  units: SiteSyncGroupUnit[];
}

interface SiteSyncUnitFilter {
  groupCode: string;
  showBoxNos: number[];
}

const CONCURRENCY = 3;

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
   * STG 기준으로 지점의 전체 유닛 목록을 그룹별로 반환
   */
  async getStgUnits(
    officeCode: string,
  ): Promise<{ groups: SiteSyncUnitGroup[] }> {
    const siteId = await this.sgApi.getSiteIdByOfficeCode(officeCode);
    if (!siteId) return { groups: [] };

    const allUnits = await this.sgApi.getUnitsForSite(siteId);
    const groupMap = new Map<string, SiteSyncGroupUnit[]>();

    for (const unit of allUnits) {
      const parsed = parseSmartcubeId(unit.customFields?.smartcube_id);
      if (!parsed) continue;

      const unitInfo: SiteSyncGroupUnit = {
        showBoxNo: parsed.showBoxNo,
        unitId: unit.id,
        name: unit.name,
        state: canonicalizeUnitState(unit.state),
        overdue: unit['overdue'] === true,
        ownerName: '',
      };

      const existing = groupMap.get(parsed.groupCode);
      if (existing) {
        existing.push(unitInfo);
      } else {
        groupMap.set(parsed.groupCode, [unitInfo]);
      }
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

        job.subject.next({
          type: 'unit-success',
          jobId: job.id,
          unitId,
          unitName,
          current: job.current,
          total: job.total,
          attempt,
          maxAttempts: maxRetries,
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
