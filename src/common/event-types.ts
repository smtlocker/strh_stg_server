/**
 * tblBoxHistory.eventType — 중계서버가 INSERT 하는 이벤트 코드.
 *
 * 134~139 는 호호락 레거시 시스템이 정의한 PTI 연동 이벤트로 보존하되, 신규 INSERT
 * 부터는 출처/액션이 분리된 STG 전용 코드(140~156)를 사용한다. 매핑은
 * `tblEventTypeDesc` 에 등록되어 있어야 한다 (migrations/001-init-schema.sql).
 */
export const StgEventType = {
  /** 입주 완료 — webhook job.unit_moveIn.completed */
  Movein: 140,
  /** 퇴거 예약 (endTime 설정) — webhook job.unit_moveOut.created */
  MoveoutReserve: 141,
  /** 퇴거 완료 — webhook job.unit_moveOut.completed */
  MoveoutComplete: 142,
  /** 퇴거 취소 (복원) — webhook job.unit_moveOut.cancelled */
  MoveoutCancel: 143,
  /** 유닛 이전 — 기존유닛 반납 (transfer.completed 의 old unit) */
  TransferOut: 144,
  /** 유닛 이전 — 신규유닛 배정 (transfer.completed 의 new unit) */
  TransferIn: 145,
  /** 자동 오버락 (연체) — webhook unitRental.markOverdue */
  AutoOverlock: 146,
  /** 자동 오버락 해제 — webhook unitRental.unmarkOverdue */
  AutoUnlock: 147,
  /** 운영자 수동 오버락 — STG smartcube_lockUnit 체크박스 */
  ManualOverlock: 148,
  /** 운영자 수동 오버락 해제 — STG smartcube_unlockUnit 체크박스 */
  ManualUnlock: 149,
  /** PIN 자동 재생성 — webhook smartcube_generateAccessCode */
  PinAuto: 150,
  /** PIN 수동 변경 — 매니저 API PUT /api/access-code */
  PinManual: 151,
  /** sync — 입주 정보 갱신 (unit-sync.syncWithRental) */
  SyncOccupied: 152,
  /** sync — 공실 초기화 (unit-sync.syncEmpty) */
  SyncEmpty: 153,
  /** 스케줄러 자동 입주 활성 — moveIn.activate */
  SchedActivate: 154,
  /** 스케줄러 자동 퇴거 차단 — moveOut.block */
  SchedBlock: 155,
  /** 사용자 정보 변경 — webhook user.updated (현 시점 미사용 — 추후 확장) */
  UserUpdate: 156,
} as const;

export type StgEventTypeValue = (typeof StgEventType)[keyof typeof StgEventType];
