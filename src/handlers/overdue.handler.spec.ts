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
  safeRollback: jest.fn().mockImplementation((tx) => tx.rollback()),
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
    // 기본 mockQuery — markOverdue 의 새 dbState 가드 (useState/userCode SELECT) 와
    // unmarkOverdue 의 overdueCheck (cnt SELECT) 양쪽을 동시에 만족시키는 row.
    // 정상 점유 상태 (useState=1, userCode='o1') + cnt=0.
    mockQuery.mockResolvedValue({
      recordset: [{ useState: 1, userCode: 'o1', cnt: 0 }],
      rowsAffected: [1],
    });
  });

  const setupMocks = () => {
    mockSgApi.getUnitRental.mockResolvedValue({
      id: 'r1',
      unitId: 'u1',
      ownerId: 'o1',
      state: 'occupied',
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

    it('정상 → useState=3, isOverlocked=1, PTI=0, history=146', async () => {
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
        0,
        'o1',
      );
      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        146,
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

    it('DB 공실 (useState=2) → skip + noopReason="DB unit vacant"', async () => {
      // Park, Gyong jin 2026-05-04 회귀 가드. 04-29 에 퇴거된 rental 에 05-01 markOverdue
      // 가 발사돼 isOverlocked=1 잔존이 박힌 사고를 막는다.
      setupMocks();
      mockQuery.mockResolvedValueOnce({
        recordset: [{ useState: 2, userCode: '' }],
        rowsAffected: [1],
      });

      const result = await handler.handle({
        type: 'unitRental.markOverdue',
        data: { unitRentalId: 'r1' },
      });

      expect(mockTransaction.commit).not.toHaveBeenCalled();
      expect(mockSgApi.updateUnitRental).not.toHaveBeenCalled();
      expect(insertBoxHistorySnapshot).not.toHaveBeenCalled();
      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        noopReason: expect.stringContaining('DB unit vacant'),
      });
    });

    it('DB userCode 가 rental.ownerId 와 다름 → skip + noopReason="userCode mismatch"', async () => {
      setupMocks();
      mockQuery.mockResolvedValueOnce({
        recordset: [{ useState: 1, userCode: 'differentUser' }],
        rowsAffected: [1],
      });

      const result = await handler.handle({
        type: 'unitRental.markOverdue',
        data: { unitRentalId: 'r1' },
      });

      expect(mockTransaction.commit).not.toHaveBeenCalled();
      expect(insertBoxHistorySnapshot).not.toHaveBeenCalled();
      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        noopReason: expect.stringContaining('userCode mismatch'),
      });
    });

    it('DB row 자체가 없음 → skip + noopReason="DB unit not found"', async () => {
      setupMocks();
      mockQuery.mockResolvedValueOnce({ recordset: [], rowsAffected: [0] });

      const result = await handler.handle({
        type: 'unitRental.markOverdue',
        data: { unitRentalId: 'r1' },
      });

      expect(mockTransaction.commit).not.toHaveBeenCalled();
      expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        noopReason: expect.stringContaining('DB unit not found'),
      });
    });

    it.each([
      ['completed', 'completed'],
      ['reserved', 'reserved'],
      ['pre_completed', 'pre_completed'],
      ['OCCUPIED 가 아닌 대문자 변형', 'Completed'],
    ])(
      'rental.state=%s → 자동 오버락 skip + noopReason 반환',
      async (_label, state) => {
        setupMocks();
        mockSgApi.getUnitRental.mockResolvedValue({
          id: 'r1',
          unitId: 'u1',
          ownerId: 'o1',
          state,
        });

        const result = await handler.handle({
          type: 'unitRental.markOverdue',
          data: { unitRentalId: 'r1' },
        });

        expect(mockTransaction.commit).not.toHaveBeenCalled();
        expect(mockSgApi.updateUnitRental).not.toHaveBeenCalled();
        expect(insertBoxHistorySnapshot).not.toHaveBeenCalled();
        expect(setPtiUserEnableAllForGroup).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          noopReason: expect.stringContaining('not occupied'),
          areaCode: 'strh00010001',
          showBoxNo: 1,
          stgUserId: 'o1',
          stgUnitId: 'u1',
        });
      },
    );

    it('rental.state 누락 → 자동 오버락 skip + noopReason="missing"', async () => {
      setupMocks();
      mockSgApi.getUnitRental.mockResolvedValue({
        id: 'r1',
        unitId: 'u1',
        ownerId: 'o1',
        // state 미설정
      });

      const result = await handler.handle({
        type: 'unitRental.markOverdue',
        data: { unitRentalId: 'r1' },
      });

      expect(mockTransaction.commit).not.toHaveBeenCalled();
      expect(mockSgApi.updateUnitRental).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        noopReason: expect.stringContaining("state='missing'"),
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
        1,
        'o1',
      );
      expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
        mockTransaction,
        'strh00010001',
        1,
        147,
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
        147,
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
