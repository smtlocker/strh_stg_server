import { Test, TestingModule } from '@nestjs/testing';
import { TransferHandler } from './transfer.handler';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { SyncLogService } from '../monitoring/sync-log.service';

jest.mock('../common/db-utils', () => ({
  insertBoxHistorySnapshot: jest.fn().mockResolvedValue(undefined),
  relocatePtiUserToUnit: jest.fn().mockResolvedValue(undefined),
  setPtiUserEnableAllForGroup: jest.fn().mockResolvedValue(undefined),
  safeRollback: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../common/move-out-core', () => ({
  executeMoveOutCompletion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../common/utils', () => ({
  resolveUnitMapping: jest.fn(),
  extractUserInfo: jest
    .fn()
    .mockReturnValue({ userPhone: '01012345678', userName: 'Kim, Jay' }),
  findJobStep: jest.fn(),
  formatKstDate: jest.fn().mockReturnValue('2026-04-07'),
}));

import {
  insertBoxHistorySnapshot,
  relocatePtiUserToUnit,
  setPtiUserEnableAllForGroup,
  safeRollback,
} from '../common/db-utils';
import { executeMoveOutCompletion } from '../common/move-out-core';
import {
  resolveUnitMapping,
  findJobStep,
  formatKstDate,
} from '../common/utils';

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

describe('TransferHandler', () => {
  let handler: TransferHandler;
  let mockTransaction: {
    commit: jest.Mock<Promise<void>, []>;
    rollback: jest.Mock<Promise<void>, []>;
  };
  let mockSgApi: {
    getJob: jest.Mock;
    getUnit: jest.Mock;
    getUser: jest.Mock;
    getUnitRental: jest.Mock;
    getOfficeCode: jest.Mock;
    updateUnitRental: jest.Mock<
      Promise<Record<string, unknown>>,
      [string, Record<string, unknown>]
    >;
  };
  let mockSyncLog: {
    add: jest.Mock<Promise<void>, [Record<string, unknown>]>;
  };

  beforeEach(async () => {
    mockTransaction = {
      commit: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
      rollback: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    };
    mockSgApi = {
      getJob: jest.fn(),
      getUnit: jest.fn(),
      getUser: jest.fn(),
      getUnitRental: jest.fn(),
      getOfficeCode: jest.fn().mockResolvedValue('0001'),
      updateUnitRental: jest
        .fn<
          Promise<Record<string, unknown>>,
          [string, Record<string, unknown>]
        >()
        .mockResolvedValue({}),
    };
    mockSyncLog = {
      add: jest
        .fn<Promise<void>, [Record<string, unknown>]>()
        .mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransferHandler,
        {
          provide: DatabaseService,
          useValue: {
            beginTransaction: jest.fn().mockResolvedValue(mockTransaction),
          },
        },
        {
          provide: StoreganiseApiService,
          useValue: mockSgApi,
        },
        {
          provide: SyncLogService,
          useValue: mockSyncLog,
        },
      ],
    }).compile();

    handler = module.get(TransferHandler);
    jest.clearAllMocks();
    (resolveUnitMapping as jest.Mock).mockReset();
    (findJobStep as jest.Mock).mockReset();
    (formatKstDate as jest.Mock).mockReset().mockReturnValue('2026-04-07');
    mockInput.mockReturnThis();
    mockQuery.mockResolvedValue({
      recordset: [
        {
          boxPassword: '9999',
          isOverlocked: 0,
          endTime: '2099-12-31 23:59:59',
          AccessCode: '654321',
        },
      ],
      rowsAffected: [1],
    });
  });

  const setupMocks = () => {
    mockSgApi.getJob.mockResolvedValue({
      id: 'job1',
      type: 'unit_transfer',
      ownerId: 'owner1',
      data: {
        oldRentalId: 'rental-old',
        newUnitId: 'unit-new',
      },
      steps: [
        { id: 's1', type: 'start', result: { unitRentalId: 'rental-new' } },
      ],
    });
    mockSgApi.getUnitRental.mockResolvedValue({
      id: 'rental-old',
      unitId: 'unit-old',
    });
    mockSgApi.getUnit
      .mockResolvedValueOnce({
        id: 'unit-old',
        name: 'OLD',
        siteId: 's1',
        customFields: { smartcube_id: '0001:1' },
      })
      .mockResolvedValueOnce({
        id: 'unit-new',
        name: 'NEW',
        siteId: 's1',
        customFields: { smartcube_id: '0002:5' },
      });
    mockSgApi.getUser.mockResolvedValue({
      id: 'owner1',
      phone: '+82 10 1234 5678',
      lastName: 'Kim',
      firstName: 'Jay',
    });
    (resolveUnitMapping as jest.Mock)
      .mockResolvedValueOnce({
        areaCode: 'strh00010001',
        showBoxNo: 1,
        officeCode: '0001',
      })
      .mockResolvedValueOnce({
        areaCode: 'strh00010002',
        showBoxNo: 5,
        officeCode: '0001',
      });
    (findJobStep as jest.Mock).mockReturnValue({
      id: 's1',
      type: 'start',
      result: { unitRentalId: 'rental-new' },
    });
  };

  it('jobId 없으면 스킵', async () => {
    await handler.handle({ type: 'job.unit_transfer.completed', data: {} });
    expect(mockSgApi.getJob).not.toHaveBeenCalled();
  });

  it('oldRentalId 없으면 스킵', async () => {
    mockSgApi.getJob.mockResolvedValue({
      id: 'job1',
      type: 'unit_transfer',
      ownerId: 'o1',
      data: { newUnitId: 'unit-new' },
    });
    await handler.handle({
      type: 'job.unit_transfer.completed',
      data: { jobId: 'job1' },
    });
    expect(mockSgApi.getUnitRental).not.toHaveBeenCalled();
  });

  it('smartcube_id 매핑 실패 → 스킵', async () => {
    setupMocks();
    (resolveUnitMapping as jest.Mock).mockReset().mockResolvedValue(null);
    await handler.handle({
      type: 'job.unit_transfer.completed',
      data: { jobId: 'job1' },
    });
    expect(mockTransaction.commit).not.toHaveBeenCalled();
  });

  it('다른 지점 간 transfer면 스킵', async () => {
    setupMocks();
    (resolveUnitMapping as jest.Mock).mockReset();
    (resolveUnitMapping as jest.Mock)
      .mockResolvedValueOnce({
        areaCode: 'strh00010001',
        showBoxNo: 1,
        officeCode: '0001',
      })
      .mockResolvedValueOnce({
        areaCode: 'strh00200005',
        showBoxNo: 5,
        officeCode: '0002',
      });

    await handler.handle({
      type: 'job.unit_transfer.completed',
      data: { jobId: 'job1' },
    });

    expect(mockTransaction.commit).not.toHaveBeenCalled();
    expect(mockSgApi.updateUnitRental).not.toHaveBeenCalled();
  });

  it('기존유닛 PIN 복사 + 신규유닛 활성화 + PTI 유닛 이전 + 기존유닛 full reset', async () => {
    setupMocks();

    await handler.handle({
      type: 'job.unit_transfer.completed',
      data: { jobId: 'job1' },
    });

    // 기존유닛 boxPassword 조회
    expect(mockQuery).toHaveBeenCalled();
    // PTI 유닛 이전 (upsert가 아닌 relocate)
    expect(relocatePtiUserToUnit).toHaveBeenCalledWith(
      mockTransaction,
      expect.objectContaining({
        oldAreaCode: 'strh00010001',
        oldShowBoxNo: 1,
        newAreaCode: 'strh00010002',
        newShowBoxNo: 5,
        userPhone: '01012345678',
        stgUserId: 'owner1',
      }),
    );
    // office PTI enable 설정 (정상 유닛: ptiEnable=1)
    expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010002',
      '01012345678',
      1,
      'owner1',
    );
    // 기존유닛 full reset
    expect(executeMoveOutCompletion).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010001',
      1,
      '01012345678',
      expect.any(Object),
      'owner1',
      false,
      144, // TransferOut
    );
    // 신규유닛 history
    expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010002',
      5,
      145,
    );
    expect(mockTransaction.commit).toHaveBeenCalled();
  });

  it('SyncMeta 반환 (인터셉터가 로그 처리)', async () => {
    setupMocks();

    const result = await handler.handle({
      type: 'job.unit_transfer.completed',
      data: { jobId: 'job1' },
    });

    expect(result).toEqual(
      expect.objectContaining({
        areaCode: 'strh00010002',
        showBoxNo: 5,
      }),
    );
    expect(mockSyncLog.add).not.toHaveBeenCalled();
  });

  it('STG accessCode 역기록 실패 시 3회 재시도 후 error syncLog 남기고 성공 처리 유지', async () => {
    setupMocks();
    mockSgApi.updateUnitRental.mockRejectedValue(new Error('STG fail'));

    await expect(
      handler.handle({
        type: 'job.unit_transfer.completed',
        data: { jobId: 'job1' },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        areaCode: 'strh00010002',
        showBoxNo: 5,
      }),
    );

    expect(mockSgApi.updateUnitRental).toHaveBeenCalledTimes(3);
    expect(mockSyncLog.add).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.unit_transfer.rentalSync',
        status: 'error',
      }),
    );
  });

  it('PTI에 AccessCode가 없어도 startDate는 업데이트', async () => {
    setupMocks();
    // AccessCode가 null인 경우
    mockQuery.mockResolvedValue({
      recordset: [
        {
          boxPassword: '9999',
          isOverlocked: 0,
          endTime: '2099-12-31 23:59:59',
        },
      ],
      rowsAffected: [1],
    });

    await handler.handle({
      type: 'job.unit_transfer.completed',
      data: { jobId: 'job1' },
    });

    expect(mockSgApi.updateUnitRental).toHaveBeenCalledWith(
      'rental-new',
      expect.objectContaining({
        startDate: '2026-04-07',
      }),
    );
    // accessCode가 없으므로 customFields 없어야 함
    const updateCall = mockSgApi.updateUnitRental.mock.calls[0];
    expect(updateCall).toBeDefined();
    const updateBody = updateCall?.[1];
    expect(updateBody).not.toHaveProperty('customFields');
  });

  it('트랜잭션 에러 → 롤백 + throw', async () => {
    setupMocks();
    mockQuery.mockRejectedValue(new Error('DB error'));
    await expect(
      handler.handle({
        type: 'job.unit_transfer.completed',
        data: { jobId: 'job1' },
      }),
    ).rejects.toThrow('DB error');
    expect(safeRollback).toHaveBeenCalledWith(mockTransaction);
  });

  it('transfer of an overlocked unit (from old unit) → new unit inherits isOverlocked=1, useState=3 (blocked), ptiEnable=0', async () => {
    setupMocks();
    mockQuery.mockResolvedValue({
      recordset: [
        {
          boxPassword: '1234',
          isOverlocked: 1,
          endTime: '2025-06-30 23:59:59',
          AccessCode: '654321',
        },
      ],
      rowsAffected: [1],
    });

    await handler.handle({
      type: 'job.unit_transfer.completed',
      data: { jobId: 'job1' },
    });

    // Q2: 오버락 승계 → 신규 유닛 useState=3 (유닛+게이트 차단 유지)
    expect(mockInput).toHaveBeenCalledWith('useState', 'Int', 3);
    expect(mockInput).toHaveBeenCalledWith('isOverlocked', 'TinyInt', 1);
    // ptiEnable=0 → 게이트 차단
    expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010002',
      '01012345678',
      0,
      'owner1',
    );
    expect(executeMoveOutCompletion).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010001',
      1,
      '01012345678',
      expect.any(Object),
      'owner1',
      true, // wasOverlocked: 기존 유닛이 오버락이었으므로 Q7 복구 trigger
      144, // TransferOut
    );
    expect(mockTransaction.commit).toHaveBeenCalled();
  });

  it('transfer of an overlocked unit → new unit inherits isOverlocked=1, useState=3 (blocked), ptiEnable=0', async () => {
    setupMocks();
    mockQuery.mockResolvedValue({
      recordset: [
        {
          boxPassword: '1234',
          isOverlocked: 1,
          endTime: '2025-06-30 23:59:59',
          AccessCode: '654321',
        },
      ],
      rowsAffected: [1],
    });

    await handler.handle({
      type: 'job.unit_transfer.completed',
      data: { jobId: 'job1' },
    });

    // Q2: 오버락 승계 → 신규 유닛 useState=3 (유닛+게이트 차단 유지)
    expect(mockInput).toHaveBeenCalledWith('useState', 'Int', 3);
    expect(mockInput).toHaveBeenCalledWith('isOverlocked', 'TinyInt', 1);
    // ptiEnable=0 → 게이트 차단
    expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010002',
      '01012345678',
      0,
      'owner1',
    );
    expect(mockTransaction.commit).toHaveBeenCalled();
  });

  it('transfer of normal unit → useState=1, ptiEnable=1 (gate open)', async () => {
    setupMocks();
    mockQuery.mockResolvedValue({
      recordset: [
        {
          boxPassword: '1234',
          isOverlocked: 0,
          endTime: '2099-12-31 23:59:59',
          AccessCode: '654321',
        },
      ],
      rowsAffected: [1],
    });

    await handler.handle({
      type: 'job.unit_transfer.completed',
      data: { jobId: 'job1' },
    });

    // Q2: 정상 승계 → useState=1 + 게이트 오픈
    expect(mockInput).toHaveBeenCalledWith('useState', 'Int', 1);
    expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010002',
      '01012345678',
      1,
      'owner1',
    );
    expect(mockTransaction.commit).toHaveBeenCalled();
  });

  it('transfer endTime inheritance → new unit UPDATE uses inherited endTime from old unit', async () => {
    setupMocks();
    const customEndTime = '2025-12-31 23:59:59';
    mockQuery.mockResolvedValue({
      recordset: [
        {
          boxPassword: '1234',
          isOverlocked: 0,
          endTime: customEndTime,
          AccessCode: '654321',
        },
      ],
      rowsAffected: [1],
    });

    await handler.handle({
      type: 'job.unit_transfer.completed',
      data: { jobId: 'job1' },
    });

    // endTime 파라미터가 input()으로 전달됐는지 확인
    expect(mockInput).toHaveBeenCalledWith(
      'endTime',
      'NVarChar',
      customEndTime,
    );
    expect(mockTransaction.commit).toHaveBeenCalled();
  });
});
