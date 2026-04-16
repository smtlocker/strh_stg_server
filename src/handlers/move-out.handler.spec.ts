import { Test, TestingModule } from '@nestjs/testing';
import { MoveOutHandler } from './move-out.handler';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { SyncLogService } from '../monitoring/sync-log.service';
import { ScheduledJobRepository } from '../scheduler/scheduled-job.repository';
import { ScheduledJobEventType } from '../scheduler/scheduled-job.types';

// Mock external modules
jest.mock('../common/db-utils', () => ({
  insertBoxHistorySnapshot: jest.fn().mockResolvedValue(undefined),
  setPtiUserEnableAllForGroup: jest.fn().mockResolvedValue(undefined),
  parseAreaCodeParts: jest.fn(() => ({
    officeCode: '0001',
    groupCode: '0001',
  })),
  safeRollback: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../common/move-out-core', () => ({
  executeMoveOutCompletion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../common/utils', () => ({
  resolveUnitMapping: jest.fn(),
  normalizePhone: jest.fn((p: string) => p.replace(/\D/g, '')),
  extractUserInfo: jest
    .fn()
    .mockReturnValue({ userPhone: '01012345678', userName: 'Kim, Jay' }),
  findJobStep: jest.fn(),
}));

import {
  insertBoxHistorySnapshot,
  setPtiUserEnableAllForGroup,
  safeRollback,
} from '../common/db-utils';
import { executeMoveOutCompletion } from '../common/move-out-core';
import { resolveUnitMapping, findJobStep } from '../common/utils';

// Mock sql.Request
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
}));

describe('MoveOutHandler', () => {
  let handler: MoveOutHandler;
  let mockTransaction: any;
  let mockDbService: Partial<DatabaseService>;
  let mockSgApi: Partial<StoreganiseApiService>;
  let mockSyncLog: Partial<SyncLogService>;
  let mockScheduledJobRepo: {
    create: jest.Mock;
    cancelPendingForUnit: jest.Mock;
    hasPendingForUnit: jest.Mock;
  };

  beforeEach(async () => {
    mockTransaction = {
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    };

    mockDbService = {
      beginTransaction: jest.fn().mockResolvedValue(mockTransaction),
    };

    mockSgApi = {
      getJob: jest.fn(),
      getUnit: jest.fn(),
      getUser: jest.fn(),
      getOfficeCode: jest.fn().mockResolvedValue('0001'),
    };

    mockSyncLog = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    mockScheduledJobRepo = {
      create: jest.fn().mockResolvedValue(77),
      cancelPendingForUnit: jest.fn().mockResolvedValue(0),
      hasPendingForUnit: jest.fn().mockResolvedValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MoveOutHandler,
        { provide: DatabaseService, useValue: mockDbService },
        { provide: StoreganiseApiService, useValue: mockSgApi },
        { provide: SyncLogService, useValue: mockSyncLog },
        { provide: ScheduledJobRepository, useValue: mockScheduledJobRepo },
      ],
    }).compile();

    handler = module.get<MoveOutHandler>(MoveOutHandler);

    // Reset all mocks
    jest.clearAllMocks();
    mockTransaction.commit.mockResolvedValue(undefined);
    mockTransaction.rollback.mockResolvedValue(undefined);
    (mockDbService.beginTransaction as jest.Mock).mockResolvedValue(
      mockTransaction,
    );
    mockInput.mockReturnThis();
  });

  // -------------------------------------------------------------------------
  // handleCreated
  // -------------------------------------------------------------------------
  describe('handleCreated (job.unit_moveOut.created)', () => {
    const basePayload = {
      type: 'job.unit_moveOut.created' as const,
      data: { jobId: 'job1' },
    };

    beforeEach(() => {
      (mockSgApi.getJob as jest.Mock).mockResolvedValue({
        id: 'job1',
        type: 'unit_moveOut',
        data: { unitId: 'unit1', date: '2099-12-01' },
        steps: [{ id: 'step1', type: 'confirmMovedOut' }],
      });
      (mockSgApi.getUnit as jest.Mock).mockResolvedValue({
        id: 'unit1',
        name: 'A-101',
        siteId: 'site1',
        customFields: { smartcube_id: '0001:1' },
      });
      (resolveUnitMapping as jest.Mock).mockResolvedValue({
        areaCode: 'strh00010001',
        showBoxNo: 1,
        officeCode: '0001',
      });
      (findJobStep as jest.Mock).mockReturnValue({
        id: 'step1',
        type: 'confirmMovedOut',
      });
      mockQuery.mockResolvedValue({
        recordset: [
          {
            userPhone: '01012345678',
            userCode: 'owner1',
            userName: 'Kim, Jay',
          },
        ],
        rowsAffected: [1],
      });
    });

    it('jobId 없으면 스킵', async () => {
      await handler.handle({ type: 'job.unit_moveOut.created', data: {} });
      expect(mockSgApi.getJob).not.toHaveBeenCalled();
    });

    it('moveOutDate 없으면 스킵', async () => {
      (mockSgApi.getJob as jest.Mock).mockResolvedValue({
        id: 'job1',
        type: 'unit_moveOut',
        data: { unitId: 'unit1' },
      });
      await handler.handle(basePayload);
      expect(mockDbService.beginTransaction).not.toHaveBeenCalled();
    });

    it('smartcube_id 없으면 스킵', async () => {
      (resolveUnitMapping as jest.Mock).mockResolvedValue(null);
      await handler.handle(basePayload);
      expect(mockDbService.beginTransaction).not.toHaveBeenCalled();
    });

    it('미래 날짜 → endTime만 설정 + 커밋 + SyncMeta 반환', async () => {
      const result = await handler.handle(basePayload);

      expect(mockDbService.beginTransaction).toHaveBeenCalled();
      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        141,
      );
      expect(mockTransaction.commit).toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          areaCode: 'strh00010001',
          showBoxNo: 1,
        }),
      );
    });

    it('미래 날짜 → PTI 관련 함수 호출 없음', async () => {
      await handler.handle(basePayload);

      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
    });

    it('당일 날짜 → endTime만 설정, PTI 비활성 안 함', async () => {
      const todayStr = new Date().toISOString().split('T')[0];
      (mockSgApi.getJob as jest.Mock).mockResolvedValue({
        id: 'job1',
        type: 'unit_moveOut',
        data: { unitId: 'unit1', date: todayStr },
        steps: [{ id: 'step1', type: 'confirmMovedOut' }],
      });

      await handler.handle(basePayload);

      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        141,
      );
      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
      expect(mockTransaction.commit).toHaveBeenCalled();
    });

    it('유닛 미존재 → safeRollback + 리턴 (commit 없음)', async () => {
      mockQuery.mockResolvedValue({ recordset: [], rowsAffected: [0] });

      const result = await handler.handle(basePayload);

      expect(safeRollback).toHaveBeenCalledWith(mockTransaction);
      expect(mockTransaction.commit).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('트랜잭션 에러 시 롤백 + throw', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      await expect(handler.handle(basePayload)).rejects.toThrow('DB error');
      expect(mockTransaction.rollback).toHaveBeenCalled();
    });

    it('미래 날짜 → moveOut.block schedule job 등록', async () => {
      await handler.handle(basePayload);

      expect(mockScheduledJobRepo.create).toHaveBeenCalledWith(
        mockTransaction,
        expect.objectContaining({
          eventType: ScheduledJobEventType.MoveOutBlock,
          areaCode: 'strh00010001',
          showBoxNo: 1,
          sourceEventType: 'job.unit_moveOut.created',
          sourceEventId: 'job1',
          correlationKey: 'webhook:job.unit_moveOut.created:job1',
        }),
      );
      const callArg = mockScheduledJobRepo.create.mock.calls[0][1];
      expect(callArg.scheduledAt).toBeInstanceOf(Date);
      // endTime: '2099-12-01 23:59:59' → year 2099
      expect(callArg.scheduledAt.getFullYear()).toBe(2099);
    });

    it('당일 → moveOut.block schedule job도 등록 (오늘 23:59:59)', async () => {
      const todayStr = new Date().toISOString().split('T')[0];
      (mockSgApi.getJob as jest.Mock).mockResolvedValue({
        id: 'job1',
        type: 'unit_moveOut',
        data: { unitId: 'unit1', date: todayStr },
        steps: [{ id: 'step1', type: 'confirmMovedOut' }],
      });

      await handler.handle(basePayload);

      expect(mockScheduledJobRepo.create).toHaveBeenCalledWith(
        mockTransaction,
        expect.objectContaining({
          eventType: ScheduledJobEventType.MoveOutBlock,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // handleCompleted — 즉시 reset 정책
  // -------------------------------------------------------------------------
  describe('handleCompleted (job.unit_moveOut.completed)', () => {
    const payload = {
      type: 'job.unit_moveOut.completed' as const,
      data: { jobId: 'job1' },
    };

    beforeEach(() => {
      (mockSgApi.getJob as jest.Mock).mockResolvedValue({
        id: 'job1',
        type: 'unit_moveOut',
        ownerId: 'owner1',
        result: { ownerId: 'owner1' },
        data: { unitId: 'unit1' },
      });
      (mockSgApi.getUnit as jest.Mock).mockResolvedValue({
        id: 'unit1',
        name: 'A-101',
        siteId: 'site1',
        customFields: { smartcube_id: '0001:1' },
      });
      (mockSgApi.getUser as jest.Mock).mockResolvedValue({
        id: 'owner1',
        phone: '01012345678',
      });
      (resolveUnitMapping as jest.Mock).mockResolvedValue({
        areaCode: 'strh00010001',
        showBoxNo: 1,
        officeCode: '0001',
      });
      mockQuery.mockResolvedValue({
        recordset: [
          {
            isOverlocked: 0,
            userPhone: '01012345678',
          },
        ],
        rowsAffected: [1],
      });
    });

    it('jobId 없으면 스킵', async () => {
      await handler.handle({ type: 'job.unit_moveOut.completed', data: {} });
      expect(mockSgApi.getJob).not.toHaveBeenCalled();
    });

    it('smartcube_id 없으면 스킵', async () => {
      (resolveUnitMapping as jest.Mock).mockResolvedValue(null);
      await handler.handle(payload);
      expect(mockDbService.beginTransaction).not.toHaveBeenCalled();
    });

    it('정상 흐름 → 스케줄 등록 없이 즉시 executeMoveOutCompletion 호출 + commit', async () => {
      await handler.handle(payload);

      // 1) tblBoxMaster 사전 SELECT — overlock 조회
      const allQueries = mockQuery.mock.calls.map((c) => c[0] as string);
      expect(
        allQueries.some(
          (q) =>
            q.includes('SELECT') &&
            q.includes('isOverlocked') &&
            q.includes('userPhone'),
        ),
      ).toBe(true);

      // 2) 즉시 reset 공통 로직 호출 (7번째 인자 wasOverlocked=false)
      expect(executeMoveOutCompletion).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        '01012345678',
        expect.anything(), // logger
        'owner1',
        false, // wasOverlocked
      );

      // 3) 스케줄 등록 없음 — 즉시 reset 정책이라 후속 스케줄 불필요
      expect(mockScheduledJobRepo.create).not.toHaveBeenCalled();

      // 4) 기존 pending moveOut.block + moveIn.activate 모두 cancel
      expect(mockScheduledJobRepo.cancelPendingForUnit).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        [
          ScheduledJobEventType.MoveOutBlock,
          ScheduledJobEventType.MoveInActivate,
        ],
        expect.any(String),
      );

      // 5) 별도 useState=1 / 143 history insert 없음
      expect(allQueries.some((q) => q.includes('useState = 1'))).toBe(false);
      expect(insertBoxHistorySnapshot).not.toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        143,
      );

      expect(mockTransaction.commit).toHaveBeenCalled();
    });

    it('isOverlocked=1 → wasOverlocked=true 로 executeMoveOutCompletion 호출', async () => {
      mockQuery.mockResolvedValue({
        recordset: [
          {
            isOverlocked: 1,
            userPhone: '01012345678',
          },
        ],
        rowsAffected: [1],
      });

      await handler.handle(payload);

      expect(executeMoveOutCompletion).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        '01012345678',
        expect.anything(),
        'owner1',
        true, // wasOverlocked=true
      );
      expect(mockTransaction.commit).toHaveBeenCalled();
    });

    it('isOverlocked=0 → skip 가드 없음, 정상 reset 진행 (Q6-B)', async () => {
      mockQuery.mockResolvedValue({
        recordset: [
          {
            isOverlocked: 0,
            userPhone: '01012345678',
          },
        ],
        rowsAffected: [1],
      });

      await handler.handle(payload);

      expect(executeMoveOutCompletion).toHaveBeenCalled();
      expect(mockTransaction.commit).toHaveBeenCalled();
      expect(mockTransaction.rollback).not.toHaveBeenCalled();
    });

    it('유닛 미존재 → safeRollback + softError', async () => {
      mockQuery.mockResolvedValue({ recordset: [], rowsAffected: [0] });

      const result = await handler.handle(payload);

      expect(executeMoveOutCompletion).not.toHaveBeenCalled();
      expect(safeRollback).toHaveBeenCalledWith(mockTransaction);
      expect(mockTransaction.commit).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        softError: expect.stringContaining('unit not found'),
      });
    });

    it('executeMoveOutCompletion 에러 → 롤백 + throw', async () => {
      (executeMoveOutCompletion as jest.Mock).mockRejectedValueOnce(
        new Error('reset failed'),
      );
      await expect(handler.handle(payload)).rejects.toThrow('reset failed');
      expect(mockTransaction.rollback).toHaveBeenCalled();
      expect(mockTransaction.commit).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // handleCancelled
  // -------------------------------------------------------------------------
  describe('handleCancelled (job.unit_moveOut.cancelled)', () => {
    const payload = {
      type: 'job.unit_moveOut.cancelled' as const,
      data: { jobId: 'job1' },
    };

    beforeEach(() => {
      (mockSgApi.getJob as jest.Mock).mockResolvedValue({
        id: 'job1',
        type: 'unit_moveOut',
        data: { unitId: 'unit1' },
      });
      (mockSgApi.getUnit as jest.Mock).mockResolvedValue({
        id: 'unit1',
        name: 'A-101',
        siteId: 'site1',
        customFields: { smartcube_id: '0001:1' },
      });
      (resolveUnitMapping as jest.Mock).mockResolvedValue({
        areaCode: 'strh00010001',
        showBoxNo: 1,
        officeCode: '0001',
      });
      mockQuery.mockResolvedValue({ recordset: [], rowsAffected: [1] });
    });

    it('jobId 없으면 스킵', async () => {
      await handler.handle({ type: 'job.unit_moveOut.cancelled', data: {} });
      expect(mockSgApi.getJob).not.toHaveBeenCalled();
    });

    it('smartcube_id 없으면 스킵', async () => {
      (resolveUnitMapping as jest.Mock).mockResolvedValue(null);
      await handler.handle(payload);
      expect(mockDbService.beginTransaction).not.toHaveBeenCalled();
    });

    it('정상 흐름 (useState=1) → endTime 2099 복원 + history 143 + SyncMeta 반환', async () => {
      mockQuery.mockResolvedValue({
        recordset: [
          {
            useState: 1,
            isOverlocked: 0,
            userPhone: '01012345678',
            userCode: 'owner1',
            userName: 'Kim, Jay',
          },
        ],
        rowsAffected: [1],
      });

      const result = await handler.handle(payload);

      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        143,
      );
      expect(mockTransaction.commit).toHaveBeenCalled();
      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          areaCode: 'strh00010001',
          showBoxNo: 1,
        }),
      );
    });

    it('차단된 유닛 (useState=3, isOverlocked=0) + 다른 blocker 없음 → useState=1 복원 + PTI 활성', async () => {
      mockQuery
        // 1st query: SELECT unit state
        .mockResolvedValueOnce({
          recordset: [
            {
              useState: 3,
              isOverlocked: 0,
              userPhone: '01012345678',
              userCode: 'owner1',
              userName: 'Kim, Jay',
            },
          ],
          rowsAffected: [1],
        })
        // 2nd query: UPDATE tblBoxMaster (endTime + useState=1)
        .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] })
        // 3rd query: blocker count check → 0 other blockers
        .mockResolvedValueOnce({ recordset: [{ cnt: 0 }], rowsAffected: [0] });

      await handler.handle(payload);

      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(
          `UPDATE tblBoxMaster SET endTime = '2099-12-31 23:59:59', useState = 1, updateTime = GETDATE()`,
        ),
      );
      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        '01012345678',
        1,
        'owner1',
      );
      expect(mockTransaction.commit).toHaveBeenCalled();
    });

    it('차단된 유닛 (wasBlocked) + 다른 blocker 존재 → PTI 복원 안 함', async () => {
      mockQuery
        .mockResolvedValueOnce({
          recordset: [
            {
              useState: 3,
              isOverlocked: 0,
              userPhone: '01012345678',
              userCode: 'owner1',
              userName: 'Kim, Jay',
            },
          ],
          rowsAffected: [1],
        })
        .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] })
        // blocker count → 1 other blocker remains
        .mockResolvedValueOnce({ recordset: [{ cnt: 1 }], rowsAffected: [0] });

      await handler.handle(payload);

      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
      expect(mockTransaction.commit).toHaveBeenCalled();
    });

    it('isOverlocked=1 → wasBlocked=false, PTI 복원 안 함', async () => {
      mockQuery.mockResolvedValueOnce({
        recordset: [
          {
            useState: 3,
            isOverlocked: 1,
            userPhone: '01012345678',
            userCode: 'owner1',
            userName: 'Kim, Jay',
          },
        ],
        rowsAffected: [1],
      });

      await handler.handle(payload);

      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
      expect(mockTransaction.commit).toHaveBeenCalled();
    });

    it('isOverlocked=1 유닛이어도 endTime만 복원, useState/PTI 변경 안 함', async () => {
      mockQuery.mockResolvedValue({
        recordset: [
          {
            useState: 3,
            isOverlocked: 1,
            userPhone: '01012345678',
            userCode: 'owner1',
            userName: 'Kim, Jay',
          },
        ],
        rowsAffected: [1],
      });

      await handler.handle(payload);

      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(
          `UPDATE tblBoxMaster SET endTime = '2099-12-31 23:59:59', updateTime = GETDATE()`,
        ),
      );
      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
      expect(mockTransaction.commit).toHaveBeenCalled();
    });

    it('트랜잭션 에러 시 롤백 + throw', async () => {
      mockQuery.mockRejectedValue(new Error('DB error'));
      await expect(handler.handle(payload)).rejects.toThrow('DB error');
      expect(mockTransaction.rollback).toHaveBeenCalled();
    });

    it('정상 흐름 → 동일 unit의 pending moveOut.block 만 cancel', async () => {
      mockQuery.mockResolvedValue({
        recordset: [
          {
            useState: 1,
            isOverlocked: 0,
            userPhone: '01012345678',
            userCode: 'owner1',
            userName: 'Kim, Jay',
          },
        ],
        rowsAffected: [1],
      });
      mockScheduledJobRepo.cancelPendingForUnit.mockResolvedValueOnce(1);

      await handler.handle(payload);

      expect(mockScheduledJobRepo.cancelPendingForUnit).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        [ScheduledJobEventType.MoveOutBlock],
        expect.stringContaining('webhook:job.unit_moveOut.cancelled:job1'),
      );
    });
  });
});
