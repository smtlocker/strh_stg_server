import { AsyncLocalStorage } from 'async_hooks';

/**
 * 한 번의 webhook/scheduler/site-sync request 처리 동안 inner 코드 (예: STG API
 * retry 루프) 가 sync-log row 를 작성할 때 필요한 컨텍스트.
 *
 * 호출 진입점 (WebhookLogInterceptor, scheduler, site-sync 작업 스레드 등)
 * 에서 `runWithSyncLogContext()` 로 감싸면, 그 안에서 호출되는 모든 로직은
 * `getSyncLogContext()` 를 통해 컨텍스트를 읽을 수 있다.
 *
 * recordRetry 콜백은 진입점 측에서 SyncLogService 와 미리 묶어두기 때문에
 * StoreganiseApiService 등 inner 모듈은 SyncLogService 를 직접 import 하지
 * 않아도 retry row 를 기록할 수 있다 (순환 의존성 회피).
 */
export interface RetryRecord {
  error: string;
  attempt: number;
  maxAttempts: number;
  /** 부가 payload (예: STG endpoint, status code) — sync-log payload.* 에 병합 */
  extra?: Record<string, unknown>;
}

export interface SyncLogContext {
  source: 'webhook' | 'scheduler' | 'site-sync' | 'user-sync';
  eventType: string;
  eventId: string | null;
  businessCode: string | null;
  /** request 시작 시각 (Date.now()). retry row 의 durationMs 계산에 사용. */
  startTime: number;
  /** 미리 계산된 correlationKey (있으면). 없으면 SyncLogService 가 추론. */
  correlationKey?: string | null;
  /**
   * 사전할당된 tblSyncLog.id. 진입점이 request 시작에 SyncLogService.prepare()
   * 로 placeholder row 를 INSERT 하고 그 id 를 여기에 박아두면, 처리 중
   * insertBoxHistorySnapshot 이 tblBoxHistory.syncLogId 에 채워 history ↔
   * syncLog 단일 JOIN 추적이 가능해진다. 미설정(undefined) 이면 NULL 로 INSERT.
   * (TODO: 진입점 측 prepare/complete 패턴 도입 필요. 현재는 항상 undefined.)
   */
  syncLogId?: number | null;
  /** 중간 실패(재시도 직전) 를 sync-log 에 기록하는 콜백. alert 는 자동 suppress. */
  recordRetry: (record: RetryRecord) => void;
}

const storage = new AsyncLocalStorage<SyncLogContext>();

export function runWithSyncLogContext<T>(
  context: SyncLogContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

export function getSyncLogContext(): SyncLogContext | undefined {
  return storage.getStore();
}
