-- ============================================================
-- 001: 초기 스키마 설정
--
-- 새 중계서버 배치 시 1회 실행.
-- 기존 테이블(tblBoxMaster, tblPTIUserInfo)에 컬럼/제약 추가 +
-- 신규 테이블(tblSyncLog, tblScheduledJob) 생성.
-- 모든 단계 멱등 (IF NOT EXISTS 체크).
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. tblSyncLog 생성
-- ────────────────────────────────────────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_NAME = 'tblSyncLog'
)
BEGIN
  CREATE TABLE tblSyncLog (
    id                BIGINT IDENTITY(1,1) PRIMARY KEY,
    source            NVARCHAR(20)   NOT NULL,       -- 'webhook' | 'scheduler' | 'site-sync'
    eventType         NVARCHAR(60)   NOT NULL,
    eventId           NVARCHAR(100)  NULL,
    correlationKey    NVARCHAR(200)  NULL,
    businessCode      NVARCHAR(100)  NULL,
    areaCode          NVARCHAR(20)   NULL,
    showBoxNo         INT            NULL,
    userName          NVARCHAR(100)  NULL,
    userPhone         NVARCHAR(30)   NULL,
    stgUserId         NVARCHAR(100)  NULL,
    stgUnitId         NVARCHAR(100)  NULL,
    replayedFromLogId BIGINT         NULL,
    alertSentAt       DATETIME2      NULL,
    alertStatus       NVARCHAR(30)   NULL,
    status            NVARCHAR(10)   NOT NULL,       -- 'success' | 'error'
    attempt           INT            NULL,
    maxAttempts       INT            NULL,
    durationMs        INT            NOT NULL DEFAULT 0,
    error             NVARCHAR(MAX)  NULL,
    payload           NVARCHAR(MAX)  NULL,
    createdAt         DATETIME2      NOT NULL DEFAULT GETDATE()
  );

  CREATE INDEX IX_tblSyncLog_createdAt      ON tblSyncLog (createdAt DESC);
  CREATE INDEX IX_tblSyncLog_source         ON tblSyncLog (source);
  CREATE INDEX IX_tblSyncLog_eventType      ON tblSyncLog (eventType);
  CREATE INDEX IX_tblSyncLog_correlationKey ON tblSyncLog (correlationKey);
  PRINT 'tblSyncLog 테이블 + 인덱스 생성 완료';
END
ELSE
BEGIN
  PRINT 'tblSyncLog 이미 존재합니다. (스킵)';
END
GO


-- ────────────────────────────────────────────────────────────
-- 2. tblBoxMaster 컬럼 추가
-- ────────────────────────────────────────────────────────────

-- isOverlocked: 관리자 강제 잠금 플래그 (schedule worker 가드)
IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'tblBoxMaster' AND COLUMN_NAME = 'isOverlocked'
)
BEGIN
  ALTER TABLE tblBoxMaster ADD isOverlocked tinyint NOT NULL
    CONSTRAINT DF_tblBoxMaster_isOverlocked DEFAULT 0;
  PRINT 'tblBoxMaster.isOverlocked 추가 완료';
END
ELSE PRINT 'tblBoxMaster.isOverlocked 이미 존재 (스킵)';
GO

-- PK: (areaCode, boxNo) CLUSTERED
IF NOT EXISTS (
  SELECT 1 FROM sys.key_constraints
  WHERE parent_object_id = OBJECT_ID('dbo.tblBoxMaster') AND type = 'PK'
)
BEGIN
  ALTER TABLE tblBoxMaster
    ADD CONSTRAINT PK_BoxMaster PRIMARY KEY CLUSTERED (areaCode, boxNo);
  PRINT 'PK_BoxMaster 생성 완료';
END
ELSE PRINT 'PK_BoxMaster 이미 존재 (스킵)';
GO

-- Unique: (areaCode, showBoxNo) filtered
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UQ_BoxMaster_Show' AND object_id = OBJECT_ID('dbo.tblBoxMaster')
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX UQ_BoxMaster_Show
    ON tblBoxMaster (areaCode, showBoxNo)
    WHERE showBoxNo IS NOT NULL;
  PRINT 'UQ_BoxMaster_Show 생성 완료';
END
ELSE PRINT 'UQ_BoxMaster_Show 이미 존재 (스킵)';
GO


-- ────────────────────────────────────────────────────────────
-- 3. tblPTIUserInfo 컬럼 추가
-- ────────────────────────────────────────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'tblPTIUserInfo' AND COLUMN_NAME = 'StgUserId'
)
BEGIN
  ALTER TABLE tblPTIUserInfo ADD StgUserId varchar(30) NULL;
  PRINT 'tblPTIUserInfo.StgUserId 추가 완료';
END
ELSE PRINT 'tblPTIUserInfo.StgUserId 이미 존재 (스킵)';
GO


-- ────────────────────────────────────────────────────────────
-- 4. tblScheduledJob 생성
-- ────────────────────────────────────────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_NAME = 'tblScheduledJob'
)
BEGIN
  CREATE TABLE tblScheduledJob (
    jobId             BIGINT IDENTITY(1,1) PRIMARY KEY,

    -- 작업 식별
    eventType         NVARCHAR(64)  NOT NULL,
    scheduledAt       DATETIME      NOT NULL,
    status            NVARCHAR(16)  NOT NULL
      CONSTRAINT DF_ScheduledJob_Status DEFAULT 'pending',

    -- 실행 컨텍스트
    areaCode          NVARCHAR(20)  NOT NULL,
    showBoxNo         INT           NOT NULL,
    userPhone         NVARCHAR(20)  NULL,
    userCode          NVARCHAR(30)  NULL,
    userName          NVARCHAR(100) NULL,
    payload           NVARCHAR(MAX) NULL,

    -- 파생 이벤트 추적
    sourceEventType   NVARCHAR(64)  NULL,
    sourceEventId     NVARCHAR(64)  NULL,
    correlationKey    NVARCHAR(100) NULL,

    -- 실행 상태
    attempts          INT           NOT NULL
      CONSTRAINT DF_ScheduledJob_Attempts DEFAULT 0,
    maxAttempts       INT           NOT NULL
      CONSTRAINT DF_ScheduledJob_MaxAttempts DEFAULT 3,
    nextRetryAt       DATETIME      NULL,
    executedAt        DATETIME      NULL,
    lastError         NVARCHAR(MAX) NULL,

    -- 감사
    createdAt         DATETIME      NOT NULL
      CONSTRAINT DF_ScheduledJob_CreatedAt DEFAULT GETDATE(),
    updatedAt         DATETIME      NOT NULL
      CONSTRAINT DF_ScheduledJob_UpdatedAt DEFAULT GETDATE()
  );

  CREATE NONCLUSTERED INDEX IX_ScheduledJob_PendingDue
    ON tblScheduledJob (status, scheduledAt)
    INCLUDE (eventType, areaCode, showBoxNo)
    WHERE status = 'pending';

  CREATE NONCLUSTERED INDEX IX_ScheduledJob_Unit
    ON tblScheduledJob (areaCode, showBoxNo, eventType, status);

  CREATE NONCLUSTERED INDEX IX_ScheduledJob_CorrelationKey
    ON tblScheduledJob (correlationKey)
    WHERE correlationKey IS NOT NULL;

  PRINT 'tblScheduledJob 테이블 + 인덱스 생성 완료';
END
ELSE PRINT 'tblScheduledJob 이미 존재합니다. (스킵)';
GO

-- correlationKey filtered unique index (webhook 중복 방어)
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UQ_ScheduledJob_CorrelationKey_Active'
    AND object_id = OBJECT_ID('dbo.tblScheduledJob')
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX UQ_ScheduledJob_CorrelationKey_Active
    ON tblScheduledJob (correlationKey)
    WHERE correlationKey IS NOT NULL
      AND status IN ('pending', 'processing');
  PRINT 'UQ_ScheduledJob_CorrelationKey_Active 생성 완료';
END
ELSE PRINT 'UQ_ScheduledJob_CorrelationKey_Active 이미 존재 (스킵)';
GO
