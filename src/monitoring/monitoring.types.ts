export interface SyncMeta {
  areaCode?: string;
  showBoxNo?: number;
  userName?: string;
  stgUserId?: string;
  stgUnitId?: string;
  /**
   * handler가 throw 없이 조기 return하지만 운영자 주의가 필요한 케이스에 사용.
   * (예: STG 응답의 필수 필드 누락, smartcube_id 파싱 실패)
   * interceptor는 이 값이 있으면 sync-log를 `status='error'`로 기록한다.
   * webhook 응답 자체는 여전히 200 (STG의 자동 재시도 방지).
   */
  softError?: string;
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
