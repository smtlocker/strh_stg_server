/**
 * 웹훅 중복 이벤트 감지를 위한 dedup 키 생성.
 *
 * eventType + 대상 ID 조합으로 키를 만들어 tblSyncLog.correlationKey에 저장하고,
 * 10초 윈도우 내 동일 키의 성공 이력이 있으면 중복으로 판정한다.
 */

interface DedupPayload {
  type?: string;
  data?: {
    jobId?: string;
    unitRentalId?: string;
    userId?: string;
    unitId?: string;
    [key: string]: unknown;
  };
}

export function buildWebhookDedupKey(payload: DedupPayload): string | null {
  const type = typeof payload.type === 'string' ? payload.type : null;
  const data = payload.data;
  if (!type || !data) return null;

  let targetId: string | undefined;
  if (type.startsWith('job.unit_')) {
    targetId = data.jobId;
  } else if (type.startsWith('unitRental.')) {
    targetId = data.unitRentalId;
  } else if (type === 'user.updated') {
    targetId = data.userId;
  } else if (type === 'unit.updated') {
    targetId = data.unitId;
  }

  return targetId ? `webhook:${type}:${targetId}` : null;
}
