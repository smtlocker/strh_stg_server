import { Test, TestingModule } from '@nestjs/testing';
import { UnitSyncHandler } from './unit-sync.handler';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { ScheduledJobRepository } from '../scheduler/scheduled-job.repository';

jest.mock('../common/db-utils', () => ({
  insertBoxHistorySnapshot: jest.fn().mockResolvedValue(undefined),
  findExistingAccessCode: jest.fn(),
  generateUniqueAccessCode: jest.fn(),
  upsertPtiUserForUnit: jest.fn(),
  deletePtiUserForUnit: jest.fn().mockResolvedValue(undefined),
  setPtiUserEnableAllForGroup: jest.fn(),
  safeRollback: jest.fn().mockImplementation((tx) => tx.rollback()),
}));

jest.mock('../common/utils', () => ({
  resolveUnitMapping: jest.fn(),
  extractUserInfo: jest.fn(),
  normalizePhone: jest.fn((p: string) => p),
}));

import {
  insertBoxHistorySnapshot,
  findExistingAccessCode,
  generateUniqueAccessCode,
  upsertPtiUserForUnit,
  deletePtiUserForUnit,
  setPtiUserEnableAllForGroup,
} from '../common/db-utils';
import { resolveUnitMapping, extractUserInfo, normalizePhone } from '../common/utils';

const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
jest.mock('mssql', () => ({
  Request: jest
    .fn()
    .mockImplementation(() => ({ input: mockInput, query: mockQuery })),
  NVarChar: 'NVarChar',
  Int: 'Int',
  Bit: 'Bit',
}));

describe('UnitSyncHandler', () => {
  let handler: UnitSyncHandler;
  let mockSgApi: {
    getUnitRental: jest.Mock;
    getUser: jest.Mock;
    updateUnitRental: jest.Mock;
  };
  const mockTransaction = {
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UnitSyncHandler,
        {
          provide: DatabaseService,
          useValue: {
            beginTransaction: jest.fn().mockResolvedValue(mockTransaction),
          },
        },
        {
          provide: StoreganiseApiService,
          useValue: {
            getUnitRental: jest.fn(),
            getUser: jest.fn(),
            getJob: jest.fn(),
            updateUnitRental: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: ScheduledJobRepository,
          useValue: {
            cancelPendingForUnit: jest.fn().mockResolvedValue(0),
            create: jest.fn().mockResolvedValue(1),
            hasPendingForUnit: jest.fn().mockResolvedValue(false),
          },
        },
      ],
    }).compile();

    handler = module.get(UnitSyncHandler);
    mockSgApi = module.get(StoreganiseApiService);
    jest.clearAllMocks();
    (extractUserInfo as jest.Mock).mockReturnValue({
      userPhone: '01012345678',
      userName: 'Kim, Jay',
    });
    mockInput.mockReturnThis();
  });

  it('syncEmpty resets box and deletes per-unit PTI using current box identity', async () => {
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });

    mockQuery
      .mockResolvedValueOnce({
        recordset: [{ userPhone: '01012345678', userCode: 'owner1' }],
        rowsAffected: [1],
      })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    await handler.syncUnit({
      id: 'unit1',
      rentalId: null,
      customFields: { smartcube_id: '0001:1' },
    });

    expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010001',
      1,
      153,
    );
    expect(deletePtiUserForUnit).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010001',
      1,
      '01012345678',
      'owner1',
    );
    expect(mockTransaction.commit).toHaveBeenCalled();
  });

  it('STG unit.state=blocked 이면 syncUnit 조기 skip — DB/STG 호출 없음', async () => {
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });

    const result = await handler.syncUnit({
      id: 'unit1',
      state: 'blocked',
      rentalId: null,
      customFields: { smartcube_id: '0001:1' },
    });

    expect(result).toBeNull();
    expect(mockSgApi.getUnitRental).not.toHaveBeenCalled();
    expect(insertBoxHistorySnapshot).not.toHaveBeenCalled();
    expect(deletePtiUserForUnit).not.toHaveBeenCalled();
    expect(mockTransaction.commit).not.toHaveBeenCalled();
  });

  it('STG unit.state=Blocked (대소문자) 도 동일하게 skip', async () => {
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });

    const result = await handler.syncUnit({
      id: 'unit1',
      state: 'Blocked',
      rentalId: null,
      customFields: { smartcube_id: '0001:1' },
    });

    expect(result).toBeNull();
    expect(insertBoxHistorySnapshot).not.toHaveBeenCalled();
  });

  it('reserved rental state with rentalId still syncs as empty', async () => {
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });
    mockSgApi.getUnitRental.mockResolvedValue({
      id: 'rental1',
      state: 'reserved',
    });

    mockQuery
      .mockResolvedValueOnce({
        recordset: [{ userPhone: '01012345678', userCode: 'owner1' }],
        rowsAffected: [1],
      })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    await handler.syncUnit({
      id: 'unit1',
      rentalId: 'rental1',
      customFields: { smartcube_id: '0001:1' },
    });

    expect(mockSgApi.getUnitRental).toHaveBeenCalledWith('rental1');
    expect(mockSgApi.getUser).not.toHaveBeenCalled();
    expect(deletePtiUserForUnit).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010001',
      1,
      '01012345678',
      'owner1',
    );
    expect(mockSgApi.updateUnitRental).not.toHaveBeenCalled();
  });

  it('occupied rental state keeps rental sync path', async () => {
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });
    mockSgApi.getUnitRental.mockResolvedValue({
      id: 'rental1',
      ownerId: 'owner1',
      state: 'occupied',
      startDate: '2026-04-07',
      customFields: {},
    });
    mockSgApi.getUser.mockResolvedValue({
      id: 'owner1',
      phone: '01012345678',
      lastName: 'Kim',
      firstName: 'Jay',
    });
    (findExistingAccessCode as jest.Mock).mockResolvedValue('654321');
    (generateUniqueAccessCode as jest.Mock).mockResolvedValue('123456');

    mockQuery
      // pre-read (changed 산출용)
      .mockResolvedValueOnce({ recordset: [{ useState: 1, userCode: 'owner1', userName: 'Kim, Jay', userPhone: '01012345678', isOverlocked: 0 }], rowsAffected: [1] })
      // tblBoxMaster UPDATE
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] })
      // blocker check
      .mockResolvedValueOnce({ recordset: [{ cnt: 0 }], rowsAffected: [1] });

    await handler.syncUnit({
      id: 'unit1',
      rentalId: 'rental1',
      state: 'occupied',
      customFields: { smartcube_id: '0001:1' },
    });

    expect(mockSgApi.getUser).toHaveBeenCalledWith('owner1');
    expect(upsertPtiUserForUnit).toHaveBeenCalledWith(
      mockTransaction,
      expect.objectContaining({
        areaCode: 'strh00010001',
        showBoxNo: 1,
        accessCode: '654321',
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
    expect(deletePtiUserForUnit).not.toHaveBeenCalled();
    expect(mockSgApi.updateUnitRental).toHaveBeenCalledWith('rental1', {
      customFields: { gate_code: '654321' },
    });
  });

  it('rental.state 누락 → STG 응답 이상으로 throw', async () => {
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });
    mockSgApi.getUnitRental.mockResolvedValue({
      id: 'rental1',
      // state intentionally omitted
    });

    await expect(
      handler.syncUnit({
        id: 'unit1',
        rentalId: 'rental1',
        customFields: { smartcube_id: '0001:1' },
      }),
    ).rejects.toThrow(/has no state/);

    expect(mockSgApi.getUser).not.toHaveBeenCalled();
    expect(deletePtiUserForUnit).not.toHaveBeenCalled();
    expect(mockSgApi.updateUnitRental).not.toHaveBeenCalled();
  });

  it('occupied rental.ownerId 누락 → STG 응답 이상으로 throw', async () => {
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });
    mockSgApi.getUnitRental.mockResolvedValue({
      id: 'rental1',
      state: 'occupied',
      // ownerId intentionally omitted
    });

    await expect(
      handler.syncUnit({
        id: 'unit1',
        rentalId: 'rental1',
        customFields: { smartcube_id: '0001:1' },
      }),
    ).rejects.toThrow(/has no ownerId/);

    expect(mockSgApi.getUser).not.toHaveBeenCalled();
  });

  it('changed=false 반환: DB 현재 상태가 sync 결과와 완전 동일하면 no-op', async () => {
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });
    mockSgApi.getUnitRental.mockResolvedValue({
      id: 'rental1',
      ownerId: 'owner1',
      state: 'occupied',
      startDate: '2026-04-07',
      customFields: {},
    });
    mockSgApi.getUser.mockResolvedValue({ id: 'owner1' });
    (findExistingAccessCode as jest.Mock).mockResolvedValue('654321');
    (generateUniqueAccessCode as jest.Mock).mockResolvedValue('123456');

    mockQuery
      // pre-read: DB 가 sync 결과(useState=1, userCode=owner1, name=Kim,Jay, phone=01012345678, isOverlocked=0)와 동일
      .mockResolvedValueOnce({
        recordset: [
          { useState: 1, userCode: 'owner1', userName: 'Kim, Jay', userPhone: '01012345678', isOverlocked: 0 },
        ],
        rowsAffected: [1],
      })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] })
      .mockResolvedValueOnce({ recordset: [{ cnt: 0 }], rowsAffected: [1] });

    const result = await handler.syncUnit({
      id: 'unit1',
      rentalId: 'rental1',
      state: 'occupied',
      customFields: { smartcube_id: '0001:1' },
    });
    expect(result?.changed).toBe(false);
  });

  it('changed=true 반환: DB userCode 가 sync 결과와 다르면 변경 감지', async () => {
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });
    mockSgApi.getUnitRental.mockResolvedValue({
      id: 'rental1',
      ownerId: 'owner1',
      state: 'occupied',
      startDate: '2026-04-07',
      customFields: {},
    });
    mockSgApi.getUser.mockResolvedValue({ id: 'owner1' });
    (findExistingAccessCode as jest.Mock).mockResolvedValue('654321');
    (generateUniqueAccessCode as jest.Mock).mockResolvedValue('123456');

    mockQuery
      // pre-read: DB 에 다른 userCode 가 박혀 있음
      .mockResolvedValueOnce({
        recordset: [
          { useState: 1, userCode: 'owner-legacy', userName: 'Kim, Jay', userPhone: '01012345678', isOverlocked: 0 },
        ],
        rowsAffected: [1],
      })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] })
      .mockResolvedValueOnce({ recordset: [{ cnt: 0 }], rowsAffected: [1] });

    const result = await handler.syncUnit({
      id: 'unit1',
      rentalId: 'rental1',
      state: 'occupied',
      customFields: { smartcube_id: '0001:1' },
    });
    expect(result?.changed).toBe(true);
  });

  it('changed=false: DB 에 하이픈 포함 전화번호가 있어도 normalize 하여 동일로 판정', async () => {
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });
    mockSgApi.getUnitRental.mockResolvedValue({
      id: 'rental1',
      ownerId: 'owner1',
      state: 'occupied',
      startDate: '2026-04-07',
      customFields: {},
    });
    mockSgApi.getUser.mockResolvedValue({ id: 'owner1' });
    (findExistingAccessCode as jest.Mock).mockResolvedValue('654321');
    (generateUniqueAccessCode as jest.Mock).mockResolvedValue('123456');
    (normalizePhone as jest.Mock).mockImplementation((p: string) =>
      (p ?? '').replace(/\D/g, ''),
    );

    mockQuery
      // pre-read: DB 전화번호는 하이픈 포함 레거시 포맷
      .mockResolvedValueOnce({
        recordset: [
          { useState: 1, userCode: 'owner1', userName: 'Kim, Jay', userPhone: '010-1234-5678', isOverlocked: 0 },
        ],
        rowsAffected: [1],
      })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] })
      .mockResolvedValueOnce({ recordset: [{ cnt: 0 }], rowsAffected: [1] });

    const result = await handler.syncUnit({
      id: 'unit1',
      rentalId: 'rental1',
      state: 'occupied',
      customFields: { smartcube_id: '0001:1' },
    });
    expect(result?.changed).toBe(false);
  });
});
