-- ============================================================
-- 006: tblBoxHistory.isOverlocked 컬럼 추가
--
-- 배경 (2026-05-04 게이트 비활성화 사고):
--   기존 tblBoxHistory 는 호호락 레거시 스키마 그대로 30개 컬럼만 스냅샷한다.
--   tblBoxMaster 에는 우리가 추가한 isOverlocked 가 있으나 history 에는 없음.
--   그래서 "특정 시점의 unit 의 isOverlocked 가 0 이었는지 1 이었는지" 를
--   history 만 보고는 알 수 없어 사고 추적이 매우 느렸다.
--
-- 효과:
--   1) 모든 신규 스냅샷에 isOverlocked 가 같이 박힘 → 시점별 0↔1 전이 추적 가능
--   2) 외부(레거시 호호락) 가 박은 history row 와 우리 row 를 비교할 때, 우리
--      row 는 항상 isOverlocked 값을 가지고 있어 전후 비교가 가능
--
-- 멱등 — 컬럼이 이미 있으면 스킵.
-- ============================================================

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'tblBoxHistory' AND COLUMN_NAME = 'isOverlocked'
)
BEGIN
  ALTER TABLE tblBoxHistory ADD isOverlocked tinyint NULL;
  PRINT 'tblBoxHistory.isOverlocked 추가 완료';
END
ELSE PRINT 'tblBoxHistory.isOverlocked 이미 존재 (스킵)';
GO
