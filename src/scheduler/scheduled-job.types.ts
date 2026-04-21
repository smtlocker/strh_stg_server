/**
 * tblScheduledJob 테이블을 중심으로 한 스케줄러 타입 정의.
 *
 * 기존 UnifiedSchedulerService가 사용하던 "DB 상태 추론" 방식에서
 * 명시적 job 큐 방식으로 전환한다. handler가 webhook을 받는 시점에
 * 미래 작업을 tblScheduledJob에 INSERT하고, worker가 분 단위로
 * due job을 꺼내 실행한다.
 */

export enum ScheduledJobEventType {
  /** useState=3 차단 상태를 useState=1로 활성화 (moveIn.completed + 미래 startDate 파생) */
  MoveInActivate = 'moveIn.activate',
  /** useState=1 활성 상태를 useState=3로 차단 (moveOut.created + 미래 endTime 파생) */
  MoveOutBlock = 'moveOut.block',
  /** 웹훅 핸들러 실패 시 비동기 재시도 (payload에 원본 웹훅 데이터 저장) */
  WebhookRetry = 'webhook.retry',
}

export const ALL_SCHEDULED_JOB_EVENT_TYPES: ScheduledJobEventType[] = [
  ScheduledJobEventType.MoveInActivate,
  ScheduledJobEventType.MoveOutBlock,
  ScheduledJobEventType.WebhookRetry,
];

export enum ScheduledJobStatus {
  /** 실행 대기 */
  Pending = 'pending',
  /** worker가 점유하여 실행 중 */
  Processing = 'processing',
  /** 정상 실행 완료 */
  Success = 'success',
  /** maxAttempts 초과로 영구 실패 (이메일 발송 대상) */
  Failed = 'failed',
  /**
   * @deprecated 현재 worker 는 stale 마킹을 하지 않는다. 과거 stale scanner 가
   * 기록한 historical row 조회와 reprocess.requeue 호환을 위해 enum 값만 유지.
   */
  Stale = 'stale',
  /** webhook 취소/대체 또는 운영자에 의해 취소 */
  Cancelled = 'cancelled',
  /** 실행 시점에 overlock/overdue 가드로 skip */
  Skipped = 'skipped',
}

export interface ScheduledJobRow {
  jobId: number;
  eventType: ScheduledJobEventType;
  scheduledAt: Date;
  status: ScheduledJobStatus;

  areaCode: string;
  showBoxNo: number;
  userPhone: string | null;
  userCode: string | null;
  userName: string | null;
  payload: string | null;

  sourceEventType: string | null;
  sourceEventId: string | null;
  correlationKey: string | null;

  attempts: number;
  maxAttempts: number;
  nextRetryAt: Date | null;
  executedAt: Date | null;
  lastError: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface CreateScheduledJobInput {
  eventType: ScheduledJobEventType;
  scheduledAt: Date;
  areaCode: string;
  showBoxNo: number;
  userPhone?: string | null;
  userCode?: string | null;
  userName?: string | null;
  payload?: object | null;
  sourceEventType?: string | null;
  sourceEventId?: string | null;
  correlationKey?: string | null;
  maxAttempts?: number;
}

/**
 * schedule worker가 job 실행 후 tblSyncLog에 기록할 때 사용하는 eventType.
 * 기존 UnifiedSchedulerService가 사용하던 이름과 동일하여 monitoring 호환성 유지.
 */
export const SCHEDULED_JOB_SYNC_LOG_EVENT: Record<
  ScheduledJobEventType,
  string
> = {
  [ScheduledJobEventType.MoveInActivate]: 'job.unit_moveIn.activated',
  [ScheduledJobEventType.MoveOutBlock]: 'job.unit_moveOut.blocked',
  [ScheduledJobEventType.WebhookRetry]: 'webhook.retried',
};

/**
 * 재시도 backoff (분 단위).
 *  - attempt 1 실패 → 1분 후 재시도
 *  - attempt 2 실패 → 5분 후 재시도
 *  - attempt 3 실패 → 15분 후 재시도
 *  - attempt 4 실패 → 영구 실패 (failed, 이메일 알림)
 */
export const RETRY_BACKOFF_MINUTES: readonly number[] = [1, 5, 15];

/** attempts가 이 값을 초과하면 failed 처리 */
export const MAX_ATTEMPTS_DEFAULT = 4;

/**
 * processing 상태가 이 시간 이상 지속되면 worker crash로 간주하고 pending으로 회수.
 * 한 tick은 최대 수 초 단위로 끝나므로 10분이면 정상 worker는 절대 걸리지 않는다.
 */
export const PROCESSING_TIMEOUT_MINUTES = 10;

/** worker가 매 tick에 한 번에 가져올 수 있는 job 수 */
export const WORKER_BATCH_SIZE = 50;

/**
 * tblScheduledJob INSERT 시 기본 maxAttempts 값.
 * handler가 별도로 지정하지 않으면 이 값 사용.
 */
export const DEFAULT_MAX_ATTEMPTS = 4;
