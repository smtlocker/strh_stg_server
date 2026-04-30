import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SiteSyncService, SiteSyncUnitGroup } from './site-sync.service';
import {
  StoreganiseApiService,
  SgUnitRental,
} from '../storeganise/storeganise-api.service';

export interface StgUnitsCachePayload {
  groups: SiteSyncUnitGroup[];
}

export interface StgUnitsCacheEntry {
  data: StgUnitsCachePayload;
  fetchedAt: Date;
}

/**
 * STG units 그리드의 서버 메모리 캐시.
 *
 * - 30분 주기 delta sync (`?updatedAfter=cursor` 로 변경 rental 만 fetch 후
 *   영향받은 office 캐시를 in-place patch)
 * - 매일 새벽 4시 (Asia/Seoul) 풀 스윕 — 안전망 + cursor bootstrap. 11지점이
 *   단일 `getActiveRentals()` 결과를 공유하므로 STG 호출은 1회.
 * - webhook 발생 시 해당 지점 invalidate (5초 leading-edge debounce per office)
 * - 서버 기동 시 prefetch 없음. STG 토글 클릭 시 on-demand fetch.
 *
 * STG 측 권고 (2026-04 incident):
 *   풀 데이터 sweep 일 1회 한정, 평소엔 updatedAfter cursor 로 delta sync.
 */
@Injectable()
export class StgUnitsCacheService {
  private readonly logger = new Logger(StgUnitsCacheService.name);
  private readonly cache = new Map<string, StgUnitsCacheEntry>();
  private readonly inFlight = new Map<string, Promise<StgUnitsCacheEntry>>();
  private officeCodes: string[] = [];
  /** delta sync high-water mark. 풀 스윕에서 부트스트랩되며 메모리에만 유지 */
  private deltaCursor: Date | null = null;
  /** invalidate debounce — `officeCode -> 무시 만료 시각(ms)` */
  private readonly debounceUntil = new Map<string, number>();
  private static readonly INVALIDATE_DEBOUNCE_MS = 5_000;

  constructor(
    private readonly siteSync: SiteSyncService,
    private readonly sgApi: StoreganiseApiService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cron entrypoints
  // ---------------------------------------------------------------------------

  @Cron(CronExpression.EVERY_30_MINUTES)
  async scheduledDelta(): Promise<void> {
    await this.runDelta();
  }

  @Cron('0 4 * * *', { timeZone: 'Asia/Seoul' })
  async scheduledFullSweep(): Promise<void> {
    await this.runFullSweep();
  }

  // ---------------------------------------------------------------------------
  // Public read API
  // ---------------------------------------------------------------------------

  get(officeCode: string): StgUnitsCacheEntry | null {
    return this.cache.get(officeCode) ?? null;
  }

  /** 캐시 우선, 없으면 on-demand fetch 후 저장 */
  async getOrFetch(officeCode: string): Promise<StgUnitsCacheEntry> {
    const cached = this.cache.get(officeCode);
    if (cached) return cached;
    return this.refresh(officeCode);
  }

  /**
   * 동일 officeCode 동시 refresh 중복 방지. `prefetchedRentals` 가 주어지면
   * `getActiveRentals()` STG 호출을 건너뛰고 그것을 재사용한다 (풀 스윕에서
   * 단일 fetch 결과를 11지점이 공유하기 위함).
   */
  async refresh(
    officeCode: string,
    prefetchedRentals?: SgUnitRental[],
  ): Promise<StgUnitsCacheEntry> {
    const pending = this.inFlight.get(officeCode);
    if (pending) return pending;
    const p = (async () => {
      try {
        const data = await this.siteSync.getStgUnits(
          officeCode,
          prefetchedRentals,
        );
        const entry: StgUnitsCacheEntry = { data, fetchedAt: new Date() };
        this.cache.set(officeCode, entry);
        this.logger.log(
          `[stg-cache] refreshed ${officeCode} (groups=${data.groups.length})`,
        );
        return entry;
      } finally {
        this.inFlight.delete(officeCode);
      }
    })();
    this.inFlight.set(officeCode, p);
    return p;
  }

  /**
   * webhook 수신 시 해당 지점 캐시를 백그라운드로 재생성 (fire-and-forget).
   * 동일 officeCode 의 invalidate 가 5초 내 연속 발생하면 leading-edge 만
   * 처리하고 나머지는 drop — webhook 폭주 시 불필요한 STG 호출 방지.
   */
  invalidate(officeCode: string): void {
    if (!officeCode) return;
    const now = Date.now();
    const blockedUntil = this.debounceUntil.get(officeCode) ?? 0;
    if (now < blockedUntil) return;
    this.debounceUntil.set(
      officeCode,
      now + StgUnitsCacheService.INVALIDATE_DEBOUNCE_MS,
    );
    this.refresh(officeCode).catch((err) =>
      this.logger.warn(
        `[stg-cache] invalidate refresh failed for ${officeCode}: ${(err as Error).message}`,
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Sync drivers
  // ---------------------------------------------------------------------------

  /** 30분 delta — 변경된 rental 만 fetch 해 영향받은 office 캐시 patch */
  async runDelta(): Promise<void> {
    if (!this.deltaCursor) {
      this.logger.warn(
        '[stg-cache] delta skipped — cursor not bootstrapped (waiting for next full sweep)',
      );
      return;
    }
    const tickStart = new Date();
    const cursorIso = this.deltaCursor.toISOString();
    let updated: SgUnitRental[];
    try {
      updated = await this.sgApi.getActiveRentals({ updatedAfter: cursorIso });
    } catch (err) {
      this.logger.warn(
        `[stg-cache] delta fetch failed: ${(err as Error).message} (cache retained)`,
      );
      return;
    }
    if (updated.length === 0) {
      this.deltaCursor = tickStart;
      return;
    }

    const officesNeedingRefresh = new Set<string>();
    for (const rental of updated) {
      if (!rental.siteId) continue;
      let officeCode: string;
      try {
        officeCode = await this.sgApi.getOfficeCode(rental.siteId);
      } catch {
        continue;
      }
      const entry = this.cache.get(officeCode);
      if (!entry) continue;
      const result = this.patchRentalIntoCache(entry, rental);
      if (result === 'unit-not-found') officesNeedingRefresh.add(officeCode);
    }

    // delta rental 의 unit 이 캐시에 없으면 (새 unit 등록 가능성) 해당
    // office 만 풀 refresh 로 fallback. 11지점 전부가 아님.
    for (const officeCode of officesNeedingRefresh) {
      this.refresh(officeCode).catch((err) =>
        this.logger.warn(
          `[stg-cache] fallback refresh ${officeCode} failed: ${(err as Error).message}`,
        ),
      );
    }

    this.deltaCursor = tickStart;
    this.logger.log(
      `[stg-cache] delta: ${updated.length} rental update(s) → ${officesNeedingRefresh.size} office(s) needing fallback refresh`,
    );
  }

  /** 일 1회 풀 스윕 — 단일 getActiveRentals 로 11지점 공유 + cursor 재설정 */
  async runFullSweep(): Promise<void> {
    const tickStart = new Date();
    if (this.officeCodes.length === 0) {
      try {
        const sites = await this.sgApi.getSites();
        this.officeCodes = sites
          .map((s) =>
            (s.customFields?.smartcube_siteCode || '').padStart(4, '0'),
          )
          .filter((c) => c !== '0000' && c.length === 4);
      } catch (err) {
        this.logger.warn(
          `[stg-cache] full sweep — failed to list sites: ${(err as Error).message}`,
        );
        return;
      }
    }

    let prefetched: SgUnitRental[];
    try {
      prefetched = await this.sgApi.getActiveRentals();
    } catch (err) {
      this.logger.warn(
        `[stg-cache] full sweep — getActiveRentals failed: ${(err as Error).message} (cache retained)`,
      );
      return;
    }

    for (const code of this.officeCodes) {
      try {
        await this.refresh(code, prefetched);
      } catch (err) {
        this.logger.warn(
          `[stg-cache] full sweep — refresh ${code} failed: ${(err as Error).message}`,
        );
      }
    }
    this.deltaCursor = tickStart;
    this.logger.log(
      `[stg-cache] full sweep complete — cursor reset to ${tickStart.toISOString()}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * delta rental 한 건을 캐시 entry 에 in-place 반영.
   * 'unit-not-found' 면 호출자가 해당 office full refresh 로 보정한다.
   */
  private patchRentalIntoCache(
    entry: StgUnitsCacheEntry,
    rental: SgUnitRental,
  ): 'patched' | 'no-change' | 'unit-not-found' {
    for (const group of entry.data.groups) {
      for (const unit of group.units) {
        if (unit.unitId !== rental.unitId) continue;
        const cf = (rental.customFields ?? {}) as Record<string, unknown>;
        const newOverlocked = cf.smartcube_lockStatus === 'overlocked';
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const futureStart = !!(
          rental.startDate && new Date(`${rental.startDate}T00:00:00`) > today
        );
        let changed = false;
        if (unit.overlocked !== newOverlocked) {
          unit.overlocked = newOverlocked;
          changed = true;
        }
        // 미래 startDate 로 전환되면 occupied → blocked 로 즉시 반영
        // (반대 방향 future→past 는 unit-level 재평가 필요해 webhook + full
        //  sweep 에 위임)
        if (futureStart && unit.state === 'occupied') {
          unit.state = 'blocked';
          changed = true;
        }
        if (changed) entry.fetchedAt = new Date();
        return changed ? 'patched' : 'no-change';
      }
    }
    return 'unit-not-found';
  }
}
