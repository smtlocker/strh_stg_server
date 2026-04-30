import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { getSyncLogContext } from '../common/sync-log-context';

// ---------------------------------------------------------------------------
// STG API 응답 타입 (optional + index signature)
// ---------------------------------------------------------------------------

export interface SgSite {
  id: string;
  name: string;
  code?: string;
  customFields?: {
    smartcube_siteCode?: string;
    admin_email?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SgJobStepResult {
  unitId?: string;
  unitRentalId?: string;
  [key: string]: unknown;
}

/**
 * STG job이 완료된 후 최종 결과를 담는 객체.
 * `unit_moveIn` 같은 job 타입에서 할당된 unit 정보를 여기서 읽는다.
 */
export interface SgJobResult {
  unitId?: string;
  unitRentalId?: string;
  ownerId?: string;
  siteId?: string;
  unitTypeId?: string;
  startDate?: string;
  [key: string]: unknown;
}

export interface SgJobStep {
  id: string;
  type: string;
  state?: string;
  completedAt?: string;
  completedBy?: string;
  result?: SgJobStepResult;
  data?: Record<string, unknown>;
}

export interface SgJobData {
  unitId?: string;
  date?: string;
  moveOutDate?: string;
  startDate?: string;
  transferDate?: string;
  oldRentalId?: string;
  newUnitId?: string;
  unitRentalId?: string;
  newRentalId?: string;
  skipEmails?: boolean;
  [key: string]: unknown;
}

export interface SgJob {
  id: string;
  type: string;
  ownerId?: string;
  userId?: string;
  steps?: SgJobStep[];
  data?: SgJobData;
  result?: SgJobResult;
  state?: string;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export interface SgUnit {
  id: string;
  name: string;
  siteId?: string;
  ownerId?: string;
  rentalId?: string;
  state?: string;
  customFields?: { smartcube_id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SgRentalCustomFields {
  gate_code?: string;
  smartcube_generateAccessCode?: boolean;
  smartcube_lockStatus?: string;
  smartcube_lockUnit?: boolean;
  smartcube_unlockUnit?: boolean;
  [key: string]: unknown;
}

export interface SgUnitRental {
  id: string;
  unitId: string;
  siteId?: string;
  ownerId?: string;
  startDate?: string;
  state?: string;
  customFields?: SgRentalCustomFields;
  [key: string]: unknown;
}

export interface SgUser {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  mobile?: string;
  isActive?: boolean;
  name?: string;
  customFields?: Record<string, unknown>;
  [key: string]: unknown;
}

export class StoreganiseApiException extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'StoreganiseApiException';
  }
}

@Injectable()
export class StoreganiseApiService {
  private readonly logger = new Logger(StoreganiseApiService.name);
  private readonly officeCodeCache = new Map<string, string>();

  /** sites 응답 메모리 캐시. 1시간 TTL — getSiteIdByOfficeCode 가 cron tick
   * 마다 11회씩 같은 응답을 받던 부담을 제거한다. 사이트 추가/삭제 빈도 매우
   * 낮은 운영 특성을 활용. */
  private sitesCache: { data: SgSite[]; fetchedAt: number } | null = null;
  private static readonly SITES_CACHE_TTL_MS = 60 * 60 * 1000;

  /** DEBUG: 남은 강제 실패 횟수 (0이면 정상 동작) */
  static __debugFailCount = 0;

  constructor(private readonly httpService: HttpService) {}

  async getSites(): Promise<SgSite[]> {
    const now = Date.now();
    if (
      this.sitesCache &&
      now - this.sitesCache.fetchedAt < StoreganiseApiService.SITES_CACHE_TTL_MS
    ) {
      return this.sitesCache.data;
    }
    const data = await this.request<SgSite[]>(
      'GET',
      '/v1/admin/sites?include=customFields',
    );
    this.sitesCache = { data, fetchedAt: now };
    return data;
  }

  async getJob(jobId: string): Promise<SgJob> {
    return this.request<SgJob>(
      'GET',
      `/v1/admin/jobs/${jobId}?include=customFields`,
    );
  }

  async getUnit(unitId: string): Promise<SgUnit> {
    return this.request<SgUnit>(
      'GET',
      `/v1/admin/units/${unitId}?include=customFields`,
    );
  }

  async getAllUsers(): Promise<SgUser[]> {
    const limit = 1000;
    let offset = 0;
    const users: SgUser[] = [];

    while (true) {
      const page = await this.request<SgUser[]>(
        'GET',
        `/v1/admin/users?limit=${limit}&offset=${offset}&include=customFields`,
      );
      users.push(...page);
      if (page.length < limit) break;
      offset += limit;
    }

    const seen = new Set<string>();
    return users.filter((u) => {
      if (seen.has(u.id)) return false;
      seen.add(u.id);
      return true;
    });
  }

  async getUnitsForSite(siteId: string): Promise<SgUnit[]> {
    const limit = 1000;
    let offset = 0;
    const units: SgUnit[] = [];

    while (true) {
      const page = await this.request<SgUnit[]>(
        'GET',
        `/v1/admin/units?siteId=${siteId}&include=customFields&limit=${limit}&offset=${offset}`,
      );
      units.push(...page);
      if (page.length < limit) break;
      offset += limit;
    }

    return units;
  }

  async getSiteIdByOfficeCode(officeCode: string): Promise<string | null> {
    const sites = await this.getSites();
    for (const site of sites) {
      const raw = site.customFields?.smartcube_siteCode ?? '';
      if (raw.padStart(4, '0') === officeCode.padStart(4, '0')) return site.id;
    }
    return null;
  }

  async updateUnit(
    unitId: string,
    body: Record<string, unknown>,
  ): Promise<SgUnit> {
    return this.request<SgUnit>('PUT', `/v1/admin/units/${unitId}`, body);
  }

  async getUnitRental(rentalId: string): Promise<SgUnitRental> {
    return this.request<SgUnitRental>(
      'GET',
      `/v1/admin/unit-rentals/${rentalId}?include=customFields`,
    );
  }

  async updateUnitRental(
    rentalId: string,
    body: Record<string, unknown>,
  ): Promise<SgUnitRental> {
    return this.request<SgUnitRental>(
      'PUT',
      `/v1/admin/unit-rentals/${rentalId}`,
      body,
    );
  }

  async getUserRentals(ownerId: string): Promise<SgUnitRental[]> {
    return this.request<SgUnitRental[]>(
      'GET',
      `/v1/admin/unit-rentals?ownerId=${ownerId}&include=customFields`,
    );
  }

  /**
   * STG active rental 페이지네이션 조회. opts.updatedAfter (ISO 8601, 권장: ms
   * 정밀도 UTC) 가 주어지면 그 시각 이후 갱신된 rental 만 가져오는 delta sync.
   * 인자가 없으면 전체 active rental 을 풀 페이징 (안전망 — 일 1회만 호출).
   *
   * 안전장치: STG 가 limit 을 무시하거나 cursor 오동작 시 무한 루프 방지 위해
   *   (a) 빈 페이지 감지 시 즉시 중단
   *   (b) offset 절대 상한 (MAX_PAGES × limit)
   */
  async getActiveRentals(opts?: {
    updatedAfter?: string;
  }): Promise<SgUnitRental[]> {
    const LIMIT = 1000;
    const MAX_PAGES = 100; // 10만 rental 초과 시 이상 — STG 규모상 비현실적
    const updatedAfterParam = opts?.updatedAfter
      ? `&updatedAfter=${encodeURIComponent(opts.updatedAfter)}`
      : '';
    const all: SgUnitRental[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * LIMIT;
      const data = await this.request<SgUnitRental[]>(
        'GET',
        `/v1/admin/unit-rentals?state=active&limit=${LIMIT}&offset=${offset}&include=customFields${updatedAfterParam}`,
      );
      if (!Array.isArray(data) || data.length === 0) break;
      all.push(...data);
      if (data.length < LIMIT) break;
    }
    if (all.length >= MAX_PAGES * LIMIT) {
      throw new Error(
        `getActiveRentals: exceeded MAX_PAGES=${MAX_PAGES} (STG pagination anomaly suspected)`,
      );
    }
    return all;
  }

  async getUser(userId: string): Promise<SgUser> {
    return this.request<SgUser>(
      'GET',
      `/v1/admin/users/${userId}?include=customFields`,
    );
  }

  async getSite(siteId: string): Promise<SgSite> {
    return this.request<SgSite>(
      'GET',
      `/v1/admin/sites/${siteId}?include=customFields`,
    );
  }

  /**
   * siteId → officeCode 조회 (캐시)
   * site.customFields.smartcube_siteCode에서 officeCode를 가져옴
   */
  async getOfficeCode(siteId: string): Promise<string> {
    const cached = this.officeCodeCache.get(siteId);
    if (cached) return cached;

    const site = await this.getSite(siteId);
    const rawCode = site.customFields?.smartcube_siteCode ?? '';
    if (!rawCode) {
      throw new StoreganiseApiException(
        `Site ${siteId} has no smartcube_siteCode configured`,
      );
    }
    const officeCode = rawCode.padStart(4, '0');
    this.officeCodeCache.set(siteId, officeCode);
    return officeCode;
  }

  async completeJobStep(jobId: string, stepId: string): Promise<SgJob> {
    return this.request<SgJob>(
      'PUT',
      `/v1/admin/jobs/${jobId}/steps/${stepId}`,
      {
        state: 'completed',
        nextUnitState: 'available',
      },
    );
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<T> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // DEBUG: 강제 실패 주입
        if (StoreganiseApiService.__debugFailCount > 0) {
          StoreganiseApiService.__debugFailCount--;
          const fakeErr: any = new Error(
            `[DEBUG] Forced 500 failure on ${method} ${endpoint}`,
          );
          fakeErr.response = { status: 500 };
          throw fakeErr;
        }

        const { data } = await firstValueFrom(
          method === 'PUT'
            ? this.httpService.put<T>(endpoint, body)
            : this.httpService.get<T>(endpoint),
        );
        return data;
      } catch (err) {
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;

        const retryable = !status || status === 429 || status >= 500;
        if (retryable && attempt < maxRetries) {
          const backoff = 1000 * Math.pow(2, attempt - 1);
          this.logger.warn(
            `STG API ${method} ${endpoint} → ${status ?? 'NETWORK_ERROR'}, retry ${attempt}/${maxRetries} in ${backoff}ms`,
          );
          // ALS 컨텍스트가 있으면 retry attempt 를 sync-log row 로 기록
          getSyncLogContext()?.recordRetry({
            error: `STG API ${method} ${endpoint} → ${status ?? 'NETWORK_ERROR'}`,
            attempt,
            maxAttempts: maxRetries,
            extra: {
              source: 'stg-api',
              method,
              endpoint,
              statusCode: status ?? null,
            },
          });
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        const message = `Storeganise API error: ${method} ${endpoint} → ${status ?? 'NETWORK_ERROR'}`;
        this.logger.error(message);
        throw new StoreganiseApiException(message, status, endpoint);
      }
    }
    throw new Error('Unreachable');
  }
}
