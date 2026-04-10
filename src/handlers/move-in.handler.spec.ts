import { Test, TestingModule } from '@nestjs/testing';
import { MoveInHandler } from './move-in.handler';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { SyncLogService } from '../monitoring/sync-log.service';
import { ScheduledJobRepository } from '../scheduler/scheduled-job.repository';
import { ScheduledJobEventType } from '../scheduler/scheduled-job.types';

jest.mock('../common/db-utils', () => ({
  insertBoxHistorySnapshot: jest.fn().mockResolvedValue(undefined),
  findExistingAccessCode: jest.fn().mockResolvedValue(null),
  generateUniqueAccessCode: jest.fn().mockResolvedValue('123456'),
  upsertPtiUserForUnit: jest.fn().mockResolvedValue(undefined),
  setPtiUserEnableAllForGroup: jest.fn().mockResolvedValue(undefined),
  safeRollback: jest.fn().mockImplementation((tx) => tx.rollback()),
}));

jest.mock('../common/utils', () => ({
  resolveUnitMapping: jest.fn(),
  extractUserInfo: jest
    .fn()
    .mockReturnValue({ userPhone: '01012345678', userName: 'Kim, Jay' }),
  findJobStep: jest.fn(),
}));

import {
  insertBoxHistorySnapshot,
  findExistingAccessCode,
  upsertPtiUserForUnit,
  setPtiUserEnableAllForGroup,
} from '../common/db-utils';
import { resolveUnitMapping, findJobStep } from '../common/utils';

const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
jest.mock('mssql', () => ({
  Request: jest
    .fn()
    .mockImplementation(() => ({ input: mockInput, query: mockQuery })),
  NVarChar: 'NVarChar',
  Int: 'Int',
  TinyInt: 'TinyInt',
}));

describe('MoveInHandler', () => {
  let handler: MoveInHandler;
  let mockTransaction: any;
  let mockSgApi: any;
  let mockSyncLog: any;
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

    mockScheduledJobRepo = {
      create: jest.fn().mockResolvedValue(42),
      cancelPendingForUnit: jest.fn().mockResolvedValue(0),
      hasPendingForUnit: jest.fn().mockResolvedValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MoveInHandler,
        {
          provide: DatabaseService,
          useValue: {
            beginTransaction: jest.fn().mockResolvedValue(mockTransaction),
          },
        },
        {
          provide: StoreganiseApiService,
          useValue: {
            getJob: jest.fn(),
            getUnit: jest.fn(),
            getUser: jest.fn(),
            getOfficeCode: jest.fn().mockResolvedValue('0001'),
            updateUnitRental: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: SyncLogService,
          useValue: { add: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: ScheduledJobRepository,
          useValue: mockScheduledJobRepo,
        },
      ],
    }).compile();

    handler = module.get(MoveInHandler);
    mockSgApi = module.get(StoreganiseApiService);
    mockSyncLog = module.get(SyncLogService);

    jest.clearAllMocks();
    mockInput.mockReturnThis();
    mockQuery.mockResolvedValue({ recordset: [], rowsAffected: [1] });
    (findExistingAccessCode as jest.Mock).mockResolvedValue(null);
    (
      require('../common/db-utils').generateUniqueAccessCode as jest.Mock
    ).mockResolvedValue('123456');
  });

  const setupStgMocks = (startDate?: string) => {
    mockSgApi.getJob.mockResolvedValue({
      id: 'job1',
      type: 'unit_moveIn',
      ownerId: 'owner1',
      data: { unitId: 'unit1', startDate },
      steps: [{ id: 's1', type: 'start', result: { unitRentalId: 'rental1' } }],
    });
    mockSgApi.getUnit.mockResolvedValue({
      id: 'unit1',
      name: 'A-101',
      siteId: 'site1',
      customFields: { smartcube_id: '0001:1' },
    });
    mockSgApi.getUser.mockResolvedValue({
      id: 'owner1',
      phone: '+82 10 1234 5678',
      lastName: 'Kim',
      firstName: 'Jay',
    });
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });
    (findJobStep as jest.Mock).mockReturnValue({
      id: 's1',
      type: 'start',
      result: { unitRentalId: 'rental1' },
    });
  };

  describe('handleCompleted', () => {
    it('jobId 없으면 스킵', async () => {
      await handler.handle({ type: 'job.unit_moveIn.completed', data: {} });
      expect(mockSgApi.getJob).not.toHaveBeenCalled();
    });

    it('smartcube_id 없으면 스킵', async () => {
      setupStgMocks();
      (resolveUnitMapping as jest.Mock).mockResolvedValue(null);
      await handler.handle({
        type: 'job.unit_moveIn.completed',
        data: { jobId: 'job1' },
      });
      expect(mockTransaction.commit).not.toHaveBeenCalled();
    });

    it('startDate 없음 (즉시) → useState=1, Enable=1', async () => {
      setupStgMocks(undefined);
      await handler.handle({
        type: 'job.unit_moveIn.completed',
        data: { jobId: 'job1' },
      });

      expect(upsertPtiUserForUnit).toHaveBeenCalledWith(
        mockTransaction,
        expect.objectContaining({
          enable: 1,
          areaCode: 'strh00010001',
        }),
      );
      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        '01012345678',
        1,
        'owner1',
      );
      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        134,
      );
      expect(mockTransaction.commit).toHaveBeenCalled();
    });

    it('startDate가 오늘 → 즉시 활성화 (useState=1)', async () => {
      const today = new Date().toISOString().split('T')[0];
      setupStgMocks(today);
      await handler.handle({
        type: 'job.unit_moveIn.completed',
        data: { jobId: 'job1' },
      });

      expect(upsertPtiUserForUnit).toHaveBeenCalledWith(
        mockTransaction,
        expect.objectContaining({
          enable: 1,
        }),
      );
      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        '01012345678',
        1,
        'owner1',
      );
    });

    it('startDate가 미래 → PTI row는 생기되 Enable=0, 그룹 전체는 건드리지 않음', async () => {
      setupStgMocks('2099-12-01');
      await handler.handle({
        type: 'job.unit_moveIn.completed',
        data: { jobId: 'job1' },
      });

      expect(upsertPtiUserForUnit).toHaveBeenCalledWith(
        mockTransaction,
        expect.objectContaining({
          enable: 0,
        }),
      );
      // 미래 입주 + blocker 없음 → 그룹 전체 setPtiUserEnableAllForGroup 호출 안 함
      // (다른 활성 유닛의 Enable=1 유지)
      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
    });

    it('startDate가 미래 → moveIn.activate schedule job 등록', async () => {
      setupStgMocks('2099-12-01');
      await handler.handle({
        type: 'job.unit_moveIn.completed',
        data: { jobId: 'job1' },
      });

      expect(mockScheduledJobRepo.create).toHaveBeenCalledWith(
        mockTransaction,
        expect.objectContaining({
          eventType: ScheduledJobEventType.MoveInActivate,
          areaCode: 'strh00010001',
          showBoxNo: 1,
          userPhone: '01012345678',
          userCode: 'owner1',
          userName: 'Kim, Jay',
          sourceEventType: 'job.unit_moveIn.completed',
          sourceEventId: 'job1',
          correlationKey: 'webhook:job.unit_moveIn.completed:job1',
        }),
      );
      const callArg = mockScheduledJobRepo.create.mock.calls[0][1];
      expect(callArg.scheduledAt).toBeInstanceOf(Date);
      expect(callArg.scheduledAt.getUTCFullYear()).toBe(2099);
    });

    it('startDate가 즉시(오늘) → schedule job 등록 안 함', async () => {
      const today = new Date().toISOString().split('T')[0];
      setupStgMocks(today);
      await handler.handle({
        type: 'job.unit_moveIn.completed',
        data: { jobId: 'job1' },
      });

      expect(mockScheduledJobRepo.create).not.toHaveBeenCalled();
    });

    it('startDate 없음 → schedule job 등록 안 함', async () => {
      setupStgMocks(undefined);
      await handler.handle({
        type: 'job.unit_moveIn.completed',
        data: { jobId: 'job1' },
      });

      expect(mockScheduledJobRepo.create).not.toHaveBeenCalled();
    });

    it('기존 accessCode 있으면 같은 unit PTI를 upsert한다', async () => {
      setupStgMocks();
      (findExistingAccessCode as jest.Mock).mockResolvedValue('654321');
      await handler.handle({
        type: 'job.unit_moveIn.completed',
        data: { jobId: 'job1' },
      });

      expect(upsertPtiUserForUnit).toHaveBeenCalledWith(
        mockTransaction,
        expect.objectContaining({
          accessCode: '654321',
          areaCode: 'strh00010001',
          showBoxNo: 1,
          enable: 1,
        }),
      );
      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        '01012345678',
        1,
        'owner1',
      );
    });

    it('기존 accessCode + 즉시 활성화면 PTI가 현재 유닛 기준으로 upsert됨', async () => {
      setupStgMocks();
      (findExistingAccessCode as jest.Mock).mockResolvedValue('654321');

      await handler.handle({
        type: 'job.unit_moveIn.completed',
        data: { jobId: 'job1' },
      });

      expect(upsertPtiUserForUnit).toHaveBeenCalledWith(
        mockTransaction,
        expect.objectContaining({
          areaCode: 'strh00010001',
          showBoxNo: 1,
          userPhone: '01012345678',
          userName: 'Kim, Jay',
          enable: 1,
          stgUserId: 'owner1',
        }),
      );
      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        '01012345678',
        1,
        'owner1',
      );
    });

    it('STG rental에 accessCode 역기록', async () => {
      setupStgMocks();
      await handler.handle({
        type: 'job.unit_moveIn.completed',
        data: { jobId: 'job1' },
      });

      expect(mockSgApi.updateUnitRental).toHaveBeenCalledWith('rental1', {
        customFields: { gate_code: '123456' },
      });
    });

    it('트랜잭션 에러 → 롤백 + throw', async () => {
      setupStgMocks();
      mockQuery.mockRejectedValueOnce(new Error('DB fail'));
      await expect(
        handler.handle({
          type: 'job.unit_moveIn.completed',
          data: { jobId: 'job1' },
        }),
      ).rejects.toThrow('DB fail');
      expect(mockTransaction.rollback).toHaveBeenCalled();
    });

    it('Moves in while user has manually overlocked unit in group → upsert Enable=1, then group-wide Enable=0', async () => {
      setupStgMocks(undefined);
      // Blocker check returns 1 overlocked unit
      mockQuery
        .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] }) // tblBoxMaster UPDATE
        .mockResolvedValueOnce({ recordset: [{ cnt: 1 }], rowsAffected: [1] }); // blocker check

      await handler.handle({
        type: 'job.unit_moveIn.completed',
        data: { jobId: 'job1' },
      });

      // 즉시 입주라 upsert 는 Enable=1 로 생성
      expect(upsertPtiUserForUnit).toHaveBeenCalledWith(
        mockTransaction,
        expect.objectContaining({
          enable: 1,
          areaCode: 'strh00010001',
        }),
      );
      // blocker 있으므로 그룹 전체 Enable=0 으로 일괄 변경
      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        '01012345678',
        0,
        'owner1',
      );
      expect(mockTransaction.commit).toHaveBeenCalled();
    });
  });
});
