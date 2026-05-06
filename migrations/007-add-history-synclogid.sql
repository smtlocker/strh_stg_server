-- ============================================================
-- 007: tblBoxHistory.syncLogId 컬럼 추가
--
-- 배경 (2026-05-04 게이트 비활성화 사고):
--   특정 history row 가 어느 webhook/scheduler job 으로 인해 박혔는지 추적할
--   방법이 없어, "외부 출처 vs 우리 출처" 를 구분하려면 eventType 범위
--   (140-156=우리, 100-139=레거시) 로만 추정해야 했다. 직접 link 가 있으면
--   tblBoxHistory.syncLogId → tblSyncLog.id 단일 JOIN 으로 payload/error/timing
--   까지 한 번에 추적 가능.
--
-- 컬럼 의미:
--   - NULL → 외부 출처 (legacy 호호락 / 수동 SQL / 미마이그레이션 row)
--   - NOT NULL → 우리 webhook/scheduler 처리로 INSERT 된 row, 해당 syncLog row 에 link
--
-- 멱등 — 컬럼/인덱스가 이미 있으면 스킵.
-- ============================================================

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'tblBoxHistory' AND COLUMN_NAME = 'syncLogId'
)
BEGIN
  ALTER TABLE tblBoxHistory ADD syncLogId bigint NULL;
  PRINT 'tblBoxHistory.syncLogId 추가 완료';
END
ELSE PRINT 'tblBoxHistory.syncLogId 이미 존재 (스킵)';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_tblBoxHistory_syncLogId'
    AND object_id = OBJECT_ID('dbo.tblBoxHistory')
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_tblBoxHistory_syncLogId
    ON tblBoxHistory (syncLogId)
    WHERE syncLogId IS NOT NULL;
  PRINT 'IX_tblBoxHistory_syncLogId 생성 완료';
END
ELSE PRINT 'IX_tblBoxHistory_syncLogId 이미 존재 (스킵)';
GO
