-- ============================================================
-- 002: tblScheduledJob 백필
--
-- 마이그레이션 시점에 tblBoxMaster에 이미 등록된 미래 스케줄을
-- tblScheduledJob으로 복제합니다.
--
-- ⚠️ 멱등이 아닙니다. 반드시 1회만 실행할 것.
-- 실행 전: SELECT COUNT(*) FROM tblScheduledJob → 0인지 확인.
-- ============================================================

-- moveIn.activate: 차단 상태 + 미래 startTime + 배정 유지 + overlock 아님
INSERT INTO tblScheduledJob (
  eventType, scheduledAt, status, areaCode, showBoxNo,
  userPhone, userCode, userName, sourceEventType
)
SELECT
  'moveIn.activate',
  startTime,
  'pending',
  areaCode,
  showBoxNo,
  userPhone,
  userCode,
  userName,
  'backfill'
FROM tblBoxMaster
WHERE useState = 3
  AND startTime IS NOT NULL
  AND startTime > GETDATE()
  AND ISNULL(userPhone, '') <> ''
  AND ISNULL(isOverlocked, 0) = 0;

PRINT '[backfill] moveIn.activate: ' + CAST(@@ROWCOUNT AS NVARCHAR(20)) + ' rows';

-- moveOut.block: 활성 상태 + 미래 endTime (sentinel 제외) + useTimeType != 98
INSERT INTO tblScheduledJob (
  eventType, scheduledAt, status, areaCode, showBoxNo,
  userPhone, userCode, userName, sourceEventType
)
SELECT
  'moveOut.block',
  endTime,
  'pending',
  areaCode,
  showBoxNo,
  userPhone,
  userCode,
  userName,
  'backfill'
FROM tblBoxMaster
WHERE useState = 1
  AND endTime IS NOT NULL
  AND endTime > GETDATE()
  AND endTime < '2099-12-31 00:00:00'
  AND ISNULL(useTimeType, 0) <> 98;

PRINT '[backfill] moveOut.block: ' + CAST(@@ROWCOUNT AS NVARCHAR(20)) + ' rows';

-- moveOut.resetComplete: useTimeType=98 잔존 데이터 처리
INSERT INTO tblScheduledJob (
  eventType, scheduledAt, status, areaCode, showBoxNo,
  userPhone, userCode, userName, sourceEventType
)
SELECT
  'moveOut.resetComplete',
  endTime,
  'pending',
  areaCode,
  showBoxNo,
  userPhone,
  userCode,
  userName,
  'backfill'
FROM tblBoxMaster
WHERE useTimeType = 98
  AND endTime IS NOT NULL;

PRINT '[backfill] moveOut.resetComplete: ' + CAST(@@ROWCOUNT AS NVARCHAR(20)) + ' rows';
GO
