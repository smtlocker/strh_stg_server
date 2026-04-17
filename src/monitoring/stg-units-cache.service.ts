import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SiteSyncService, SiteSyncUnitGroup } from './site-sync.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';

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
 * - 서버 기동 시 11지점 prefetch (비블로킹)
 * - 1분 주기 백그라운드 refresh
 * - webhook 이벤트에서 해당 지점 invalidate (백그라운드 refresh 즉시 트리거)
 * - `/monitoring/api/stg-units` 는 항상 캐시를 읽어 즉답. 캐시가 비어있으면
 *   on-demand 로 한번 fetch 후 저장.
 */
@Injectable()
export class StgUnitsCacheService implements OnModuleInit {
  private readonly logger = new Logger(StgUnitsCacheService.name);
  private readonly cache = new Map<string, StgUnitsCacheEntry>();
  private readonly inFlight = new Map<string, Promise<StgUnitsCacheEntry>>();
  private officeCodes: string[] = [];

  constructor(
    private readonly siteSync: SiteSyncService,
    private readonly sgApi: StoreganiseApiService,
  ) {}

  onModuleInit(): void {
    // 기동 직후 비동기 prefetch — app.listen 을 블로킹하지 않음
    setImmediate(() => {
      this.refreshAll().catch((err) =>
        this.logger.warn(`[stg-cache] initial prefetch failed: ${(err as Error).message}`),
      );
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduledRefresh(): Promise<void> {
    await this.refreshAll();
  }

  get(officeCode: string): StgUnitsCacheEntry | null {
    return this.cache.get(officeCode) ?? null;
  }

  /** 캐시 우선, 없으면 on-demand fetch 후 저장 */
  async getOrFetch(officeCode: string): Promise<StgUnitsCacheEntry> {
    const cached = this.cache.get(officeCode);
    if (cached) return cached;
    return this.refresh(officeCode);
  }

  /** 동일 officeCode 동시 refresh 중복 방지 */
  async refresh(officeCode: string): Promise<StgUnitsCacheEntry> {
    const pending = this.inFlight.get(officeCode);
    if (pending) return pending;
    const p = (async () => {
      try {
        const data = await this.siteSync.getStgUnits(officeCode);
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

  /** webhook 수신 시 해당 지점 캐시를 백그라운드로 재생성 (fire-and-forget) */
  invalidate(officeCode: string): void {
    if (!officeCode) return;
    this.refresh(officeCode).catch((err) =>
      this.logger.warn(
        `[stg-cache] invalidate refresh failed for ${officeCode}: ${(err as Error).message}`,
      ),
    );
  }

  async refreshAll(): Promise<void> {
    if (this.officeCodes.length === 0) {
      try {
        const sites = await this.sgApi.getSites();
        this.officeCodes = sites
          .map((s) => (s.customFields?.smartcube_siteCode || '').padStart(4, '0'))
          .filter((c) => c !== '0000' && c.length === 4);
      } catch (err) {
        this.logger.warn(
          `[stg-cache] failed to list sites: ${(err as Error).message}`,
        );
        return;
      }
    }
    for (const code of this.officeCodes) {
      try {
        await this.refresh(code);
      } catch (err) {
        this.logger.warn(
          `[stg-cache] refresh ${code} failed: ${(err as Error).message}`,
        );
      }
    }
  }
}
