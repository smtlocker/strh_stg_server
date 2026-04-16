import { Logger } from '@nestjs/common';
import { executeMoveOutCompletion } from './move-out-core';

jest.mock('./db-utils', () => ({
  insertBoxHistorySnapshot: jest.fn().mockResolvedValue(undefined),
  deletePtiUserForUnit: jest.fn().mockResolvedValue(undefined),
}));

import { insertBoxHistorySnapshot, deletePtiUserForUnit } from './db-utils';

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

describe('executeMoveOutCompletion', () => {
  const mockTransaction = {} as any; // sql.Transaction mock
  const logger = new Logger('Test');

  beforeEach(() => {
    jest.clearAllMocks();
    mockInput.mockReturnThis();
    mockQuery.mockResolvedValue({ recordset: [], rowsAffected: [1] });
  });

  it('tblBoxMaster 초기화 + history 142 + 해당 유닛 PTI 삭제', async () => {
    await executeMoveOutCompletion(
      mockTransaction,
      'strh00010001',
      1,
      '01012345678',
      logger,
    );

    expect(mockQuery).toHaveBeenCalled(); // UPDATE tblBoxMaster
    expect(insertBoxHistorySnapshot).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010001',
      1,
      142,
    );
    expect(deletePtiUserForUnit).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010001',
      1,
      '01012345678',
      undefined,
    );
  });

  it('stgUserId 전달 시 유닛 단위 PTI 삭제 helper에 전달', async () => {
    await executeMoveOutCompletion(
      mockTransaction,
      'strh00010001',
      1,
      '01012345678',
      logger,
      'owner1',
    );

    expect(deletePtiUserForUnit).toHaveBeenCalledWith(
      mockTransaction,
      'strh00010001',
      1,
      '01012345678',
      'owner1',
    );
  });

  it('DB 에러 시 예외 전파', async () => {
    mockQuery.mockRejectedValue(new Error('DB error'));

    await expect(
      executeMoveOutCompletion(
        mockTransaction,
        'strh00010001',
        1,
        '010',
        logger,
      ),
    ).rejects.toThrow('DB error');
  });
});
