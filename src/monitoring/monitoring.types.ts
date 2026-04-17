export interface SyncMeta {
  areaCode?: string;
  showBoxNo?: number;
  userName?: string;
  stgUserId?: string;
  stgUnitId?: string;
  /** DB 가 sync 로 인해 실제 변경됐는지 여부 (표시용). false = no-op. */
  changed?: boolean;
  /**
   * handler가 throw 없이 조기 return하지만 운영자 주의가 필요한 케이스에 사용.
   * (예: STG 응답의 필수 필드 누락, smartcube_id 파싱 실패)
   * interceptor는 이 값이 있으면 sync-log를 `status='error'`로 기록한다.
   * webhook 응답 자체는 여전히 200 (STG의 자동 재시도 방지).
   */
  softError?: string;
  /**
   * handler 가 성공적으로 처리됐지만 실제 DB/STG 작업은 수행하지 않은 분기에서,
   * 운영자가 대시보드에서 사유를 확인할 수 있도록 남기는 설명 문자열.
   * interceptor 는 이 값을 syncLog `error` 컬럼에 기록하되 `status='success'` 는 유지한다.
   * 예: "lockUnit/unlockUnit 모두 false — 체크박스 리셋", "changedKeys 에 관련 필드 없음".
   */
  noopReason?: string;
}

export interface SyncLogEntry {
  id: number;
  source: 'webhook' | 'scheduler' | 'site-sync' | 'user-sync';
  eventType: string;
  eventId: string | null;
  correlationKey?: string | null;
  businessCode: string | null;
  areaCode: string | null;
  showBoxNo: number | null;
  userName?: string | null;
  stgUserId?: string | null;
  stgUnitId?: string | null;
  status: 'success' | 'error';
  /** 1-based retry attempt number. null = 단일 시도 (기존 row 호환). */
  attempt?: number | null;
  /** 동일 작업의 retry 한도 (보통 3). */
  maxAttempts?: number | null;
  durationMs: number;
  error: string | null;
  payload: object | null;
  createdAt: Date;
  replayedFromLogId?: number | null;
  alertSentAt?: Date | null;
  alertStatus?: string | null;
  replayable?: boolean;
  replayReason?: string | null;
}

export interface DashboardStats {
  lastEventAt: string | null;
}
