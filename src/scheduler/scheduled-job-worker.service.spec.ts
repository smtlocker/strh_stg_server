import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service';
import { SyncLogService } from '../monitoring/sync-log.service';
import { WebhookService } from '../webhook/webhook.service';
import { ScheduledJobRepository } from './scheduled-job.repository';
import { ScheduledJobWorkerService } from './scheduled-job-worker.service';
import {
  ScheduledJobEventType,
  ScheduledJobRow,
  ScheduledJobStatus,
} from './scheduled-job.types';

// ---------------------------------------------------------------------------
// Mocks for external helpers
// ---------------------------------------------------------------------------
jest.mock('../common/db-utils', () => ({
  insertBoxHistorySnapshot: jest.fn().mockResolvedValue(undefined),
  setPtiUserEnableAllForGroup: jest.fn().mockResolvedValue(undefined),
  parseAreaCodeParts: jest.fn(() => ({
    officeCode: '0001',
    groupCode: '0001',
  })),
}));

import {
  insertBoxHistorySnapshot,
  setPtiUserEnableAllForGroup,
} from '../common/db-utils';

// ---------------------------------------------------------------------------
// mssql mock — sql.Request(transaction).input(...).query(...)
// ---------------------------------------------------------------------------
const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
jest.mock('mssql', () => ({
  Request: jest.fn().mockImplementation(() => ({
    input: mockInput,
    query: mockQuery,
  })),
  NVarChar: 'NVarChar',
  Int: 'Int',
  TinyInt: 'TinyInt',
  DateTime: 'DateTime',
  MAX: 'MAX',
}));

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
function makeJob(overrides: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  const now = new Date();
  return {
    jobId: 1,
    eventType: ScheduledJobEventType.MoveInActivate,
    scheduledAt: now,
    status: ScheduledJobStatus.Pending,
    areaCode: 'strh00010001',
    showBoxNo: 1,
    userPhone: '01012345678',
    userCode: 'stg-user-1',
    userName: 'Kim, Jay',
    payload: null,
    sourceEventType: 'job.unit_moveIn.completed',
    sourceEventId: 'jobX',
    correlationKey: 'webhook:job.unit_moveIn.completed:jobX',
    attempts: 0,
    maxAttempts: 4,
    nextRetryAt: null,
    executedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('ScheduledJobWorkerService', () => {
  let worker: ScheduledJobWorkerService;
  let mockRepo: jest.Mocked<Partial<ScheduledJobRepository>>;
  let mockDb: jest.Mocked<Partial<DatabaseService>>;
  let mockSyncLog: jest.Mocked<Partial<SyncLogService>>;
  let mockWebhookSvc: { handle: jest.Mock };
  let mockTransaction: { commit: jest.Mock; rollback: jest.Mock };

  beforeEach(async () => {
    mockTransaction = {
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    };

    mockDb = {
      beginTransaction: jest.fn().mockResolvedValue(mockTransaction),
    };

    mockRepo = {
      fetchDue: jest.fn().mockResolvedValue([]),
      markStaleOlderThan: jest.fn().mockResolvedValue([]),
      reclaimStuckProcessing: jest.fn().mockResolvedValue([]),
      markProcessing: jest.fn().mockResolvedValue(undefined),
      markSuccess: jest.fn().mockResolvedValue(undefined),
      markSkipped: jest.fn().mockResolvedValue(undefined),
      markRetryPending: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    mockSyncLog = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    mockWebhookSvc = {
      handle: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledJobWorkerService,
        { provide: DatabaseService, useValue: mockDb },
        { provide: ScheduledJobRepository, useValue: mockRepo },
        { provide: SyncLogService, useValue: mockSyncLog },
        { provide: WebhookService, useValue: mockWebhookSvc },
      ],
    }).compile();

    worker = module.get<ScheduledJobWorkerService>(ScheduledJobWorkerService);

    jest.clearAllMocks();
    mockInput.mockReturnThis();
  });

  // -------------------------------------------------------------------------
  // tick — reentrancy guard
  // -------------------------------------------------------------------------
  describe('tick reentrancy', () => {
    it('동시 tick 진입 시 두 번째 호출은 skip', async () => {
      // Deferred 패턴으로 fetchDue를 외부에서 제어. 첫 번째 호출에만 적용.
      let resolveFetch!: (value: ScheduledJobRow[]) => void;
      const fetchPromise = new Promise<ScheduledJobRow[]>((resolve) => {
        resolveFetch = resolve;
      });
      (mockRepo.fetchDue as jest.Mock).mockReturnValueOnce(fetchPromise);

      // t1 시작 → microtask 큐에서 stale → fetchDue까지 진행 후 fetchPromise에서 대기
      const t1 = worker.tick();

      // 다음 microtask까지 명시적으로 양보해서 t1이 fetchDue 호출 지점에 도달하게 한다.
      // (이렇게 하지 않으면 resolveFetch가 placeholder인 채 호출되는 race가 발생)
      await new Promise((r) => setImmediate(r));

      // t2는 isRunning=true로 인해 즉시 return
      const t2 = worker.tick();
      await t2;

      // 이제 t1을 풀어준다
      resolveFetch([]);
      await t1;

      expect(mockRepo.fetchDue).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // stale scanner
  // -------------------------------------------------------------------------
  describe('processStaleJobs', () => {
    it('48h 초과 job이 있으면 stale 처리 + syncLog error 기록', async () => {
      const staleJob = makeJob({
        jobId: 99,
        status: ScheduledJobStatus.Stale,
        scheduledAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
      });
      (mockRepo.markStaleOlderThan as jest.Mock).mockResolvedValueOnce([
        staleJob,
      ]);

      await worker.tick();

      expect(mockRepo.markStaleOlderThan).toHaveBeenCalledWith(48);
      expect(mockSyncLog.add).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'scheduler',
          status: 'error',
          error: expect.stringContaining('staleness threshold'),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // executeMoveInActivate
  // -------------------------------------------------------------------------
  describe('moveIn.activate', () => {
    const job = makeJob({ eventType: ScheduledJobEventType.MoveInActivate });

    it('정상 활성화 + 다른 blocker 없음 → useState=1, setPtiUserEnableAllForGroup(1)', async () => {
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);
      mockQuery
        .mockResolvedValueOnce({
          recordset: [
            {
              useState: 3,
                            isOverlocked: 0,
              userPhone: '01012345678',
              userCode: job.userCode,
            },
          ],
        }) // SELECT current state
        .mockResolvedValueOnce({ recordset: [] }) // UPDATE useState=1
        .mockResolvedValueOnce({ recordset: [{ cnt: 0 }] }); // blocker count check

      await worker.tick();

      expect(mockRepo.markProcessing).toHaveBeenCalledWith(job.jobId);
      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        job.areaCode,
        1,
        job.userCode,
      );
      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        job.areaCode,
        job.showBoxNo,
        154,
      );
      expect(mockTransaction.commit).toHaveBeenCalled();
      expect(mockRepo.markSuccess).toHaveBeenCalledWith(job.jobId);
      expect(mockSyncLog.add).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'scheduler',
          eventType: 'job.unit_moveIn.activated',
          status: 'success',
        }),
      );
    });

    it('활성화 + isOverlocked=1 인 다른 유닛 존재 → useState=1, setPtiUserEnableAllForGroup(0)', async () => {
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);
      mockQuery
        .mockResolvedValueOnce({
          recordset: [
            {
              useState: 3,
                            isOverlocked: 0,
              userPhone: '01012345678',
              userCode: job.userCode,
            },
          ],
        }) // SELECT current state
        .mockResolvedValueOnce({ recordset: [] }) // UPDATE useState=1
        .mockResolvedValueOnce({ recordset: [{ cnt: 1 }] }); // blocker count: 1 overdue unit

      await worker.tick();

      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        job.areaCode,
        0,
        job.userCode,
      );
      expect(mockRepo.markSuccess).toHaveBeenCalledWith(job.jobId);
    });

    it('useState가 이미 1 → skip', async () => {
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);
      mockQuery.mockResolvedValueOnce({
        recordset: [
          {
            useState: 1,
                        isOverlocked: 0,
            userPhone: '01012345678',
            userCode: job.userCode,
          },
        ],
      });

      await worker.tick();

      expect(mockRepo.markSkipped).toHaveBeenCalledWith(
        job.jobId,
        expect.stringContaining('no longer blocked'),
      );
    });

    it('userPhone 비어있어도 STG uid (userCode) 만으로 정상 활성화', async () => {
      const phoneless = makeJob({
        eventType: ScheduledJobEventType.MoveInActivate,
        userPhone: '',
        userCode: 'stg-user-no-phone',
      });
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([phoneless]);
      mockQuery
        .mockResolvedValueOnce({
          recordset: [
            {
              useState: 3,
              isOverlocked: 0,
              userPhone: '',
              userCode: 'stg-user-no-phone',
            },
          ],
        }) // SELECT current state
        .mockResolvedValueOnce({ recordset: [] }) // UPDATE useState=1
        .mockResolvedValueOnce({ recordset: [{ cnt: 0 }] }); // blocker count check

      await worker.tick();

      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        phoneless.areaCode,
        1,
        'stg-user-no-phone',
      );
      expect(mockRepo.markSuccess).toHaveBeenCalledWith(phoneless.jobId);
    });

    it('userPhone 과 userCode 모두 비어있으면 skip', async () => {
      const noIdentity = makeJob({
        eventType: ScheduledJobEventType.MoveInActivate,
        userPhone: '',
        userCode: '',
      });
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([noIdentity]);

      await worker.tick();

      expect(mockRepo.markSkipped).toHaveBeenCalledWith(
        noIdentity.jobId,
        expect.stringContaining('no user identity'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // executeMoveOutBlock
  // -------------------------------------------------------------------------
  describe('moveOut.block', () => {
    const job = makeJob({ eventType: ScheduledJobEventType.MoveOutBlock });

    it('정상 차단 + 다른 활성 유닛 없음 → useState=3, setPtiUserEnableAllForGroup(0)', async () => {
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);
      mockQuery
        .mockResolvedValueOnce({
          recordset: [
            {
              useState: 1,
                            isOverlocked: 0,
              useTimeType: 99,
              userPhone: '01012345678',
              userCode: 'stg-user-1',
            },
          ],
        }) // SELECT current state
        .mockResolvedValueOnce({ recordset: [] }) // UPDATE useState=3
        .mockResolvedValueOnce({ recordset: [{ cnt: 0 }] }); // other active count: 0

      await worker.tick();

      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        job.areaCode,
        0,
        'stg-user-1',
      );
      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        job.areaCode,
        job.showBoxNo,
        155,
      );
      expect(mockRepo.markSuccess).toHaveBeenCalledWith(job.jobId);
    });

    it('정상 차단 + 사용자가 다른 활성 유닛 보유 → useState=3, PTI 건드리지 않음 (no setPtiUserEnableAllForGroup call)', async () => {
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);
      mockQuery
        .mockResolvedValueOnce({
          recordset: [
            {
              useState: 1,
                            isOverlocked: 0,
              useTimeType: 99,
              userPhone: '01012345678',
              userCode: 'stg-user-1',
            },
          ],
        }) // SELECT current state
        .mockResolvedValueOnce({ recordset: [] }) // UPDATE useState=3
        .mockResolvedValueOnce({ recordset: [{ cnt: 2 }] }); // other active count: 2

      await worker.tick();

      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
      expect(mockRepo.markSuccess).toHaveBeenCalledWith(job.jobId);
    });

    it('isOverlocked=1 → skip (이미 차단 상태)', async () => {
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);
      mockQuery.mockResolvedValueOnce({
        recordset: [
          {
            useState: 3,
                        isOverlocked: 1,
            useTimeType: 99,
            userPhone: '01012345678',
            userCode: 'stg-user-1',
          },
        ],
      });

      await worker.tick();

      expect(mockRepo.markSkipped).toHaveBeenCalledWith(
        job.jobId,
        expect.stringContaining('overlocked'),
      );
    });

    it('useTimeType=98 → skip (이미 reset 흐름)', async () => {
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);
      mockQuery.mockResolvedValueOnce({
        recordset: [
          {
            useState: 1,
                        isOverlocked: 0,
            useTimeType: 98,
            userPhone: '01012345678',
            userCode: 'stg-user-1',
          },
        ],
      });

      await worker.tick();

      expect(mockRepo.markSkipped).toHaveBeenCalledWith(
        job.jobId,
        expect.stringContaining('reset flow'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // executeWebhookRetry — 웹훅 비동기 재시도
  // -------------------------------------------------------------------------
  describe('webhook.retry', () => {
    const webhookPayload = {
      id: 'evt-100',
      type: 'unit.updated',
      businessCode: 'biz-1',
      data: { unitId: 'unit-1' },
    };

    const makeRetryJob = (attempts: number) =>
      makeJob({
        eventType: ScheduledJobEventType.WebhookRetry,
        payload: JSON.stringify(webhookPayload),
        attempts,
        maxAttempts: 3,
        sourceEventType: 'unit.updated',
        sourceEventId: 'evt-100',
        correlationKey: 'webhook-retry:unit.updated:evt-100',
      });

    it('Case 1: 1회 실패 후 2회에서 성공', async () => {
      // --- 1차 시도: handle 실패 → retry pending ---
      const job1 = makeRetryJob(0);
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job1]);
      mockWebhookSvc.handle.mockRejectedValueOnce(new Error('STG 500'));

      await worker.tick();

      expect(mockWebhookSvc.handle).toHaveBeenCalledWith(webhookPayload);
      expect(mockRepo.markRetryPending).toHaveBeenCalledWith(
        job1.jobId,
        'STG 500',
        expect.any(Date),
      );
      expect(mockRepo.markFailed).not.toHaveBeenCalled();

      jest.clearAllMocks();
      mockInput.mockReturnThis();

      // --- 2차 시도: handle 성공 ---
      const job2 = makeRetryJob(1);
      (mockRepo.fetchDue as jest.Mock)
        .mockResolvedValueOnce([]) // stale
        .mockResolvedValueOnce([]); // stuck (unused but safe)
      (mockRepo.markStaleOlderThan as jest.Mock).mockResolvedValueOnce([]);
      (mockRepo.reclaimStuckProcessing as jest.Mock).mockResolvedValueOnce([]);
      (mockRepo.fetchDue as jest.Mock).mockReset().mockResolvedValueOnce([job2]);
      (mockRepo.markStaleOlderThan as jest.Mock).mockResolvedValueOnce([]);
      (mockRepo.reclaimStuckProcessing as jest.Mock).mockResolvedValueOnce([]);
      mockWebhookSvc.handle.mockResolvedValueOnce({});

      await worker.tick();

      expect(mockWebhookSvc.handle).toHaveBeenCalledWith(webhookPayload);
      expect(mockRepo.markSuccess).toHaveBeenCalledWith(job2.jobId);
      expect(mockSyncLog.add).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'scheduler',
          eventType: 'webhook.retried',
          status: 'success',
        }),
      );
    });

    it('Case 2: 2회 실패 후 3회에서 성공', async () => {
      // --- 1차 실패 ---
      const job1 = makeRetryJob(0);
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job1]);
      mockWebhookSvc.handle.mockRejectedValueOnce(new Error('timeout'));

      await worker.tick();
      expect(mockRepo.markRetryPending).toHaveBeenCalledWith(
        job1.jobId,
        'timeout',
        expect.any(Date),
      );

      jest.clearAllMocks();
      mockInput.mockReturnThis();

      // --- 2차 실패 ---
      const job2 = makeRetryJob(1);
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job2]);
      (mockRepo.markStaleOlderThan as jest.Mock).mockResolvedValueOnce([]);
      (mockRepo.reclaimStuckProcessing as jest.Mock).mockResolvedValueOnce([]);
      mockWebhookSvc.handle.mockRejectedValueOnce(new Error('timeout'));

      await worker.tick();
      expect(mockRepo.markRetryPending).toHaveBeenCalledWith(
        job2.jobId,
        'timeout',
        expect.any(Date),
      );
      expect(mockRepo.markFailed).not.toHaveBeenCalled();

      jest.clearAllMocks();
      mockInput.mockReturnThis();

      // --- 3차 성공 ---
      const job3 = makeRetryJob(2);
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job3]);
      (mockRepo.markStaleOlderThan as jest.Mock).mockResolvedValueOnce([]);
      (mockRepo.reclaimStuckProcessing as jest.Mock).mockResolvedValueOnce([]);
      mockWebhookSvc.handle.mockResolvedValueOnce({});

      await worker.tick();
      expect(mockRepo.markSuccess).toHaveBeenCalledWith(job3.jobId);
      expect(mockSyncLog.add).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'scheduler',
          eventType: 'webhook.retried',
          status: 'success',
          attempt: 3,
          maxAttempts: 3,
        }),
      );
    });

    it('Case 3: 3회 모두 실패 → markFailed + syncLog error (이메일 알림 대상)', async () => {
      // --- 1차 실패 ---
      const job1 = makeRetryJob(0);
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job1]);
      mockWebhookSvc.handle.mockRejectedValueOnce(new Error('STG down'));

      await worker.tick();
      expect(mockRepo.markRetryPending).toHaveBeenCalled();

      jest.clearAllMocks();
      mockInput.mockReturnThis();

      // --- 2차 실패 ---
      const job2 = makeRetryJob(1);
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job2]);
      (mockRepo.markStaleOlderThan as jest.Mock).mockResolvedValueOnce([]);
      (mockRepo.reclaimStuckProcessing as jest.Mock).mockResolvedValueOnce([]);
      mockWebhookSvc.handle.mockRejectedValueOnce(new Error('STG down'));

      await worker.tick();
      expect(mockRepo.markRetryPending).toHaveBeenCalled();

      jest.clearAllMocks();
      mockInput.mockReturnThis();

      // --- 3차 실패 → 최종 실패 ---
      const job3 = makeRetryJob(2);
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job3]);
      (mockRepo.markStaleOlderThan as jest.Mock).mockResolvedValueOnce([]);
      (mockRepo.reclaimStuckProcessing as jest.Mock).mockResolvedValueOnce([]);
      mockWebhookSvc.handle.mockRejectedValueOnce(new Error('STG down'));

      await worker.tick();

      // 최종 실패 확인
      expect(mockRepo.markFailed).toHaveBeenCalledWith(
        job3.jobId,
        'STG down',
      );
      expect(mockRepo.markRetryPending).not.toHaveBeenCalled();

      // syncLog error 기록 (FailureAlertService가 이메일 발송 트리거)
      expect(mockSyncLog.add).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'scheduler',
          eventType: 'webhook.retried',
          status: 'error',
          error: 'STG down',
          attempt: 3,
          maxAttempts: 3,
        }),
      );
    });

    it('payload 없으면 skip', async () => {
      const job = makeRetryJob(0);
      job.payload = null;
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);

      await worker.tick();

      expect(mockRepo.markSkipped).toHaveBeenCalledWith(
        job.jobId,
        expect.stringContaining('No payload'),
      );
      expect(mockWebhookSvc.handle).not.toHaveBeenCalled();
    });

    it('payload JSON 파싱 실패 → skip (재시도해도 같은 결과)', async () => {
      const job = makeRetryJob(0);
      job.payload = '{invalid json';
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);

      await worker.tick();

      expect(mockRepo.markSkipped).toHaveBeenCalledWith(
        job.jobId,
        expect.stringContaining('Corrupt JSON'),
      );
      expect(mockWebhookSvc.handle).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Retry / Failed
  // -------------------------------------------------------------------------
  describe('retry + failed', () => {
    it('첫 실패 → markRetryPending (1분 backoff)', async () => {
      const job = makeJob({
        eventType: ScheduledJobEventType.MoveInActivate,
        attempts: 0,
      });
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);
      mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

      await worker.tick();

      expect(mockRepo.markRetryPending).toHaveBeenCalledWith(
        job.jobId,
        'DB connection lost',
        expect.any(Date),
      );
      const callArg = (mockRepo.markRetryPending as jest.Mock).mock
        .calls[0][2] as Date;
      const delayMs = callArg.getTime() - Date.now();
      expect(delayMs).toBeGreaterThan(50 * 1000); // ~1분
      expect(delayMs).toBeLessThan(70 * 1000);
      expect(mockRepo.markFailed).not.toHaveBeenCalled();
    });

    it('두 번째 실패 → markRetryPending (5분 backoff)', async () => {
      const job = makeJob({
        eventType: ScheduledJobEventType.MoveInActivate,
        attempts: 1,
      });
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);
      mockQuery.mockRejectedValueOnce(new Error('transient'));

      await worker.tick();

      expect(mockRepo.markRetryPending).toHaveBeenCalled();
      const callArg = (mockRepo.markRetryPending as jest.Mock).mock
        .calls[0][2] as Date;
      const delayMs = callArg.getTime() - Date.now();
      expect(delayMs).toBeGreaterThan(4 * 60 * 1000);
      expect(delayMs).toBeLessThan(6 * 60 * 1000);
    });

    it('세 번째 실패 → markRetryPending (15분 backoff)', async () => {
      const job = makeJob({
        eventType: ScheduledJobEventType.MoveInActivate,
        attempts: 2,
      });
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);
      mockQuery.mockRejectedValueOnce(new Error('transient'));

      await worker.tick();

      expect(mockRepo.markRetryPending).toHaveBeenCalled();
      const callArg = (mockRepo.markRetryPending as jest.Mock).mock
        .calls[0][2] as Date;
      const delayMs = callArg.getTime() - Date.now();
      expect(delayMs).toBeGreaterThan(14 * 60 * 1000);
      expect(delayMs).toBeLessThan(16 * 60 * 1000);
      expect(mockRepo.markFailed).not.toHaveBeenCalled();
    });

    it('네 번째 실패 → markFailed + syncLog error (이메일 알림 대상)', async () => {
      const job = makeJob({
        eventType: ScheduledJobEventType.MoveInActivate,
        attempts: 3,
      });
      (mockRepo.fetchDue as jest.Mock).mockResolvedValueOnce([job]);
      mockQuery.mockRejectedValueOnce(new Error('permanent failure'));

      await worker.tick();

      expect(mockRepo.markFailed).toHaveBeenCalledWith(
        job.jobId,
        'permanent failure',
      );
      expect(mockSyncLog.add).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'scheduler',
          status: 'error',
          error: 'permanent failure',
          attempt: 4,
          maxAttempts: 4,
        }),
      );
      expect(mockRepo.markRetryPending).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Stuck processing scanner (S4)
  // -------------------------------------------------------------------------
  describe('processStuckProcessing', () => {
    it('10분 이상 processing 상태인 job을 매 tick에 회수', async () => {
      const stuckJob = makeJob({
        jobId: 55,
        status: ScheduledJobStatus.Processing,
        attempts: 1,
      });
      (mockRepo.reclaimStuckProcessing as jest.Mock).mockResolvedValueOnce([
        stuckJob,
      ]);

      await worker.tick();

      expect(mockRepo.reclaimStuckProcessing).toHaveBeenCalledWith(10);
    });

    it('stuck 없으면 로그/추가 처리 없음 (fetchDue만 호출됨)', async () => {
      (mockRepo.reclaimStuckProcessing as jest.Mock).mockResolvedValueOnce([]);

      await worker.tick();

      expect(mockRepo.reclaimStuckProcessing).toHaveBeenCalledWith(10);
      expect(mockRepo.fetchDue).toHaveBeenCalled();
    });
  });
});
