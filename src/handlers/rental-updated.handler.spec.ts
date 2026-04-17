import { Test, TestingModule } from '@nestjs/testing';
import { RentalUpdatedHandler } from './rental-updated.handler';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';

jest.mock('../common/db-utils', () => ({
  insertBoxHistorySnapshot: jest.fn().mockResolvedValue(undefined),
  setPtiUserEnableAllForGroup: jest.fn().mockResolvedValue(undefined),
  generateUniqueAccessCode: jest.fn().mockResolvedValue('999888'),
}));

jest.mock('../common/utils', () => ({
  resolveUnitMapping: jest.fn(),
  extractUserInfo: jest
    .fn()
    .mockReturnValue({ userPhone: '01012345678', userName: 'Kim' }),
  normalizePhone: jest.fn((p: string) => {
    if (!p) return '';
    const digits = p.replace(/\D/g, '');
    return digits.startsWith('82') ? '0' + digits.slice(2) : digits;
  }),
}));

import {
  insertBoxHistorySnapshot,
  setPtiUserEnableAllForGroup,
} from '../common/db-utils';
import { resolveUnitMapping } from '../common/utils';

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

describe('RentalUpdatedHandler', () => {
  let handler: RentalUpdatedHandler;
  let mockTransaction: any;
  let mockSgApi: any;

  beforeEach(async () => {
    mockTransaction = {
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RentalUpdatedHandler,
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
            getUnit: jest.fn(),
            getUser: jest.fn(),
            getUserRentals: jest.fn().mockResolvedValue([]),
            getOfficeCode: jest.fn().mockResolvedValue('0001'),
            updateUnitRental: jest.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compile();

    handler = module.get(RentalUpdatedHandler);
    mockSgApi = module.get(StoreganiseApiService);

    jest.clearAllMocks();
    mockInput.mockReturnThis();
    mockQuery.mockResolvedValue({
      recordset: [{ useState: 1 }],
      rowsAffected: [1],
    });
  });

  const setupMocks = (customFields: Record<string, unknown> = {}) => {
    mockSgApi.getUnitRental.mockResolvedValue({
      id: 'r1',
      unitId: 'u1',
      ownerId: 'o1',
      customFields,
      startDate: '2026-04-10',
    });
    mockSgApi.getUnit.mockResolvedValue({
      id: 'u1',
      name: 'A-1',
      siteId: 's1',
      customFields: { smartcube_id: '0001:1' },
    });
    mockSgApi.getUser.mockResolvedValue({
      id: 'o1',
      phone: '+82 10 1234 5678',
      lastName: 'Kim',
    });
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });
  };

  it('changedKeys 없으면 스킵', async () => {
    await handler.handle({
      type: 'unitRental.updated',
      data: { unitRentalId: 'r1' },
    });
    expect(mockSgApi.getUnitRental).not.toHaveBeenCalled();
  });

  it('rentalId 없으면 스킵', async () => {
    await handler.handle({
      type: 'unitRental.updated',
      data: { changedKeys: ['startDate'] },
    });
    expect(mockSgApi.getUnitRental).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Manual Overlock / Remove Overlock
  // -----------------------------------------------------------------------
  describe('Manual Overlock (smartcube_lockUnit)', () => {
    it('lockUnit=true → useState=3, isOverlocked=1, office PTI=0, STG lockStatus=overlocked', async () => {
      setupMocks({ smartcube_lockUnit: true, smartcube_unlockUnit: false });
      await handler.handle({
        type: 'unitRental.updated',
        data: {
          unitRentalId: 'r1',
          changedKeys: ['customFields.smartcube_lockUnit'],
        },
      });

      // Q19: overlock 시 isOverlocked=1 마킹 — schedule worker가 락을 풀지 못하게
      const lockUpdateCall = mockQuery.mock.calls.find((c) =>
        (c[0] as string).includes('SET useState = 3'),
      );
      expect(lockUpdateCall).toBeDefined();
      expect(lockUpdateCall![0]).toContain('isOverlocked = 1');

      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        0,
        'o1',
      );
      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        148,
      );
      expect(mockSgApi.updateUnitRental).toHaveBeenCalledWith('r1', {
        customFields: {
          smartcube_lockStatus: 'overlocked',
          smartcube_lockUnit: false,
        },
      });
      expect(mockSgApi.updateUnitRental.mock.calls[0]).toEqual([
        'r1',
        {
          customFields: {
            smartcube_lockStatus: 'in progress',
          },
        },
      ]);
      expect(
        mockSgApi.updateUnitRental.mock.invocationCallOrder[0],
      ).toBeLessThan(mockSgApi.getUnit.mock.invocationCallOrder[0]);
      expect(
        mockSgApi.updateUnitRental.mock.invocationCallOrder[0],
      ).toBeLessThan(mockSgApi.getUser.mock.invocationCallOrder[0]);
    });

    it('unlockUnit=true + 다른 오버락 없음 → useState=1, isOverlocked=0, group PTI=1, STG lockStatus=overlock removed', async () => {
      setupMocks({ smartcube_lockUnit: false, smartcube_unlockUnit: true });
      mockQuery
        .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] })
        .mockResolvedValueOnce({ recordset: [{ cnt: 0 }], rowsAffected: [0] });
      await handler.handle({
        type: 'unitRental.updated',
        data: {
          unitRentalId: 'r1',
          changedKeys: ['customFields.smartcube_unlockUnit'],
        },
      });

      // Q19: unlock 시 isOverlocked=0 clear
      const unlockUpdateCall = mockQuery.mock.calls.find((c) =>
        (c[0] as string).includes('SET useState = 1'),
      );
      expect(unlockUpdateCall).toBeDefined();
      expect(unlockUpdateCall![0]).toContain('isOverlocked = 0');

      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        'o1',
      );
      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        149,
      );
      expect(mockSgApi.updateUnitRental).toHaveBeenCalledWith('r1', {
        customFields: {
          smartcube_lockStatus: 'overlock removed',
          smartcube_unlockUnit: false,
        },
      });
    });

    it('unlockUnit=true + 같은 그룹 다른 오버락 남음 → 유닛만 해제, 그룹 PTI Enable=0 유지', async () => {
      setupMocks({ smartcube_lockUnit: false, smartcube_unlockUnit: true });
      mockQuery
        .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] }) // UPDATE isOverlocked=0
        .mockResolvedValueOnce({ recordset: [{ cnt: 2 }], rowsAffected: [0] }); // other overlocked count

      await handler.handle({
        type: 'unitRental.updated',
        data: {
          unitRentalId: 'r1',
          changedKeys: ['customFields.smartcube_unlockUnit'],
        },
      });

      // 다른 오버락 유닛 있으므로 PTI 건드리지 않음
      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        149,
      );
      expect(mockSgApi.updateUnitRental).toHaveBeenCalledWith('r1', {
        customFields: {
          smartcube_lockStatus: 'overlock removed',
          smartcube_unlockUnit: false,
        },
      });
    });

    it('둘 다 true → 즉시 중단 + 체크박스 리셋', async () => {
      setupMocks({ smartcube_lockUnit: true, smartcube_unlockUnit: true });
      await handler.handle({
        type: 'unitRental.updated',
        data: {
          unitRentalId: 'r1',
          changedKeys: [
            'customFields.smartcube_lockUnit',
            'customFields.smartcube_unlockUnit',
          ],
        },
      });

      expect(mockTransaction.commit).not.toHaveBeenCalled();
      expect(mockSgApi.updateUnitRental).toHaveBeenCalledWith('r1', {
        customFields: {
          smartcube_lockUnit: false,
          smartcube_unlockUnit: false,
        },
      });
    });

    it('lockStatus가 in progress → 즉시 중단', async () => {
      setupMocks({
        smartcube_lockUnit: true,
        smartcube_lockStatus: 'in progress',
      });
      await handler.handle({
        type: 'unitRental.updated',
        data: {
          unitRentalId: 'r1',
          changedKeys: ['customFields.smartcube_lockUnit'],
        },
      });

      expect(mockTransaction.commit).not.toHaveBeenCalled();
    });

    it('체크박스 false 리셋 → 무시 (no-op)', async () => {
      setupMocks({ smartcube_lockUnit: false, smartcube_unlockUnit: false });
      await handler.handle({
        type: 'unitRental.updated',
        data: {
          unitRentalId: 'r1',
          changedKeys: ['customFields.smartcube_lockUnit'],
        },
      });

      expect(mockTransaction.commit).not.toHaveBeenCalled();
    });
  });
});
