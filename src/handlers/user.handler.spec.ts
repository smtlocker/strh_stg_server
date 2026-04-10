import { Test, TestingModule } from '@nestjs/testing';
import { UserHandler } from './user.handler';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';

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

describe('UserHandler', () => {
  let handler: UserHandler;
  let mockTransaction: any;
  let mockSgApi: any;
  let mockDbService: any;

  beforeEach(async () => {
    mockTransaction = {
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    };

    mockDbService = {
      beginTransaction: jest.fn().mockResolvedValue(mockTransaction),
      // 기본값: 추적되는 사용자 (tracked count > 0) — A 체크 통과
      query: jest
        .fn()
        .mockResolvedValue({ recordset: [{ cnt: 1 }], rowsAffected: [1] }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserHandler,
        { provide: DatabaseService, useValue: mockDbService },
        {
          provide: StoreganiseApiService,
          useValue: {
            getUser: jest.fn().mockResolvedValue({
              id: 'u1',
              phone: '+82 10 1234 5678',
              lastName: 'Kim',
              firstName: 'Jay',
              isActive: true,
            }),
          },
        },
      ],
    }).compile();

    handler = module.get(UserHandler);
    mockSgApi = module.get(StoreganiseApiService);

    jest.clearAllMocks();
    mockInput.mockReturnThis();
    mockQuery.mockResolvedValue({ rowsAffected: [1] });
    // beforeEach 의 mockClear 이후 기본값 재설정 (추적되는 사용자)
    mockDbService.query.mockResolvedValue({
      recordset: [{ cnt: 1 }],
      rowsAffected: [1],
    });
  });

  it('user.created → no-op (로그만)', async () => {
    await handler.handle({ type: 'user.created', data: { userId: 'u1' } });
    expect(mockSgApi.getUser).not.toHaveBeenCalled();
  });

  it('user.updated — userId 없으면 스킵', async () => {
    await handler.handle({ type: 'user.updated', data: {} });
    expect(mockSgApi.getUser).not.toHaveBeenCalled();
  });

  it('user.updated — 무관한 changedKeys (language) → STG 호출 없이 조용히 skip (C 필터)', async () => {
    await handler.handle({
      type: 'user.updated',
      data: { userId: 'u1', changedKeys: ['language'] },
    });
    expect(mockSgApi.getUser).not.toHaveBeenCalled();
    expect(mockDbService.beginTransaction).not.toHaveBeenCalled();
  });

  it('user.updated — changedKeys=[phone] → 정상 처리', async () => {
    await handler.handle({
      type: 'user.updated',
      data: { userId: 'u1', changedKeys: ['phone'] },
    });
    expect(mockSgApi.getUser).toHaveBeenCalled();
    expect(mockDbService.beginTransaction).toHaveBeenCalled();
  });

  it('user.updated — DB 에 추적 row 없음 → 조용히 skip (A 필터, 트랜잭션 없음)', async () => {
    mockDbService.query.mockResolvedValue({
      recordset: [{ cnt: 0 }],
      rowsAffected: [0],
    });
    await handler.handle({ type: 'user.updated', data: { userId: 'u1' } });
    expect(mockSgApi.getUser).toHaveBeenCalled();
    expect(mockDbService.beginTransaction).not.toHaveBeenCalled();
  });

  it('user.updated — 추적 row 있지만 phone 없음 → 조용히 skip (softError 아님)', async () => {
    mockSgApi.getUser.mockResolvedValue({
      id: 'u1',
      phone: '',
      lastName: 'Kim',
    });
    const result = await handler.handle({
      type: 'user.updated',
      data: { userId: 'u1' },
    });
    expect(mockDbService.beginTransaction).not.toHaveBeenCalled();
    // softError 없이 SyncMeta 반환 (성공 처리)
    expect(result).toEqual(expect.objectContaining({ stgUserId: 'u1' }));
    expect(result).not.toHaveProperty('softError');
  });

  it('user.updated — 정상 흐름: 트랜잭션으로 PTI + BoxMaster 업데이트', async () => {
    mockQuery.mockResolvedValue({ rowsAffected: [1] });
    await handler.handle({ type: 'user.updated', data: { userId: 'u1' } });

    expect(mockDbService.beginTransaction).toHaveBeenCalled();
    expect(mockTransaction.commit).toHaveBeenCalled();
  });

  it('user.updated — 에러 시 롤백 + throw', async () => {
    mockQuery.mockRejectedValue(new Error('DB fail'));
    await expect(
      handler.handle({ type: 'user.updated', data: { userId: 'u1' } }),
    ).rejects.toThrow('DB fail');
    expect(mockTransaction.rollback).toHaveBeenCalled();
  });
});
