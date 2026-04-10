import { Test, TestingModule } from '@nestjs/testing';
import { OverdueHandler } from './overdue.handler';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';

jest.mock('../common/db-utils', () => ({
  insertBoxHistorySnapshot: jest.fn().mockResolvedValue(undefined),
  parseAreaCodeParts: jest
    .fn()
    .mockReturnValue({ officeCode: '0001', groupCode: '0001' }),
  setPtiUserEnableAllForGroup: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../common/utils', () => ({
  resolveUnitMapping: jest.fn(),
  extractUserInfo: jest
    .fn()
    .mockReturnValue({ userPhone: '01012345678', userName: 'Kim' }),
}));

import {
  insertBoxHistorySnapshot,
  parseAreaCodeParts,
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

describe('OverdueHandler', () => {
  let handler: OverdueHandler;
  let mockTransaction: any;
  let mockSgApi: any;

  beforeEach(async () => {
    mockTransaction = {
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OverdueHandler,
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
            getOfficeCode: jest.fn().mockResolvedValue('0001'),
            updateUnitRental: jest.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compile();

    handler = module.get(OverdueHandler);
    mockSgApi = module.get(StoreganiseApiService);

    jest.clearAllMocks();
    mockInput.mockReturnThis();
    mockQuery.mockResolvedValue({ recordset: [{ cnt: 0 }], rowsAffected: [1] });
  });

  const setupMocks = () => {
    mockSgApi.getUnitRental.mockResolvedValue({
      id: 'r1',
      unitId: 'u1',
      ownerId: 'o1',
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
    });
    (resolveUnitMapping as jest.Mock).mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      officeCode: '0001',
    });
  };

  describe('markOverdue', () => {
    it('rentalId 없으면 스킵', async () => {
      await handler.handle({ type: 'unitRental.markOverdue', data: {} });
      expect(mockSgApi.getUnitRental).not.toHaveBeenCalled();
    });

    it('smartcube_id 없으면 스킵', async () => {
      setupMocks();
      (resolveUnitMapping as jest.Mock).mockResolvedValue(null);
      await handler.handle({
        type: 'unitRental.markOverdue',
        data: { unitRentalId: 'r1' },
      });
      expect(mockTransaction.commit).not.toHaveBeenCalled();
    });

    it('정상 → useState=3, isOverlocked=1, PTI=0, history=136', async () => {
      setupMocks();
      await handler.handle({
        type: 'unitRental.markOverdue',
        data: { unitRentalId: 'r1' },
      });

      // markOverdue: isOverlocked=1 마킹
      const updateCall = mockQuery.mock.calls.find((c) =>
        (c[0] as string).includes('UPDATE tblBoxMaster SET useState = 3'),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toContain('isOverlocked = 1');

      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        '01012345678',
        0,
        'o1',
      );
      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        136,
      );
      expect(mockTransaction.commit).toHaveBeenCalled();
    });

    it('STG에 overlock 상태와 체크박스 리셋 업데이트', async () => {
      setupMocks();
      await handler.handle({
        type: 'unitRental.markOverdue',
        data: { unitRentalId: 'r1' },
      });

      expect(mockSgApi.updateUnitRental).toHaveBeenCalledWith('r1', {
        customFields: {
          smartcube_lockStatus: 'overlocked',
          smartcube_lockUnit: false,
          smartcube_unlockUnit: false,
        },
      });
    });
  });

  describe('unmarkOverdue', () => {
    it('rentalId 없으면 스킵', async () => {
      await handler.handle({ type: 'unitRental.unmarkOverdue', data: {} });
      expect(mockSgApi.getUnitRental).not.toHaveBeenCalled();
    });

    it('다른 오버락 유닛 없으면 같은 그룹 PTI rows Enable=1, isOverlocked=0', async () => {
      setupMocks();
      mockQuery.mockResolvedValue({
        recordset: [{ cnt: 0 }],
        rowsAffected: [1],
      });
      await handler.handle({
        type: 'unitRental.unmarkOverdue',
        data: { unitRentalId: 'r1' },
      });

      // overlock 플래그도 함께 clear (Q19)
      const updateCall = mockQuery.mock.calls.find((c) =>
        (c[0] as string).includes('UPDATE tblBoxMaster SET useState = 1'),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toContain('isOverlocked = 0');

      expect(setPtiUserEnableAllForGroup).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        '01012345678',
        1,
        'o1',
      );
      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        138,
      );
    });

    it('다른 overdue 유닛이 남아 있으면 PTI는 계속 Enable=0 유지', async () => {
      setupMocks();
      mockQuery
        .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] }) // unit update
        .mockResolvedValueOnce({ recordset: [{ cnt: 2 }], rowsAffected: [0] }); // overdue count

      await handler.handle({
        type: 'unitRental.unmarkOverdue',
        data: { unitRentalId: 'r1' },
      });

      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        138,
      );
    });

    it('STG에 overlock 해제 상태와 체크박스 리셋 업데이트', async () => {
      setupMocks();
      await handler.handle({
        type: 'unitRental.unmarkOverdue',
        data: { unitRentalId: 'r1' },
      });

      expect(mockSgApi.updateUnitRental).toHaveBeenCalledWith('r1', {
        customFields: {
          smartcube_lockStatus: 'overlock removed',
          smartcube_lockUnit: false,
          smartcube_unlockUnit: false,
        },
      });
    });
  });
});
