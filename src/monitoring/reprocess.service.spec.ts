import { BadRequestException, ConflictException } from '@nestjs/common';
import { MoveInHandler } from '../handlers/move-in.handler';
import { MoveOutHandler } from '../handlers/move-out.handler';
import { OverdueHandler } from '../handlers/overdue.handler';
import { TransferHandler } from '../handlers/transfer.handler';
import { UnitSyncHandler } from '../handlers/unit-sync.handler';
import { UserHandler } from '../handlers/user.handler';
import {
  SgUnit,
  SgUnitRental,
  StoreganiseApiService,
} from '../storeganise/storeganise-api.service';
import { ReplayabilityService } from './replayability.service';
import { ReprocessService } from './reprocess.service';
import { SyncLogEntry, SyncMeta } from './monitoring.types';
import { SyncLogService } from './sync-log.service';

type SyncLogEntryInput = Omit<Partial<SyncLogEntry>, 'payload'> & {
  payload?: SyncLogEntry['payload'] | string;
};

const createSyncLogEntry = (
  overrides: SyncLogEntryInput = {},
): SyncLogEntry => ({
  id: 1,
  source: 'webhook',
  eventType: 'job.unit_moveIn.completed',
  eventId: null,
  businessCode: null,
  areaCode: null,
  showBoxNo: null,
  status: 'error',
  durationMs: 0,
  error: null,
  payload: null,
  createdAt: new Date('2026-04-06T00:00:00.000Z'),
  ...(overrides as Partial<SyncLogEntry>),
});

const createUnit = (id: string): SgUnit => ({
  id,
  name: `Unit ${id}`,
});

type ReplayDecision = ReturnType<ReplayabilityService['evaluate']>;

describe('ReprocessService', () => {
  const getById: jest.MockedFunction<SyncLogService['getById']> = jest.fn();
  const add: jest.MockedFunction<SyncLogService['add']> = jest
    .fn()
    .mockResolvedValue(createSyncLogEntry({ id: 99, status: 'success' }));
  const syncLog = {
    getById,
    add,
  } satisfies Pick<SyncLogService, 'getById' | 'add'>;
  const evaluate: jest.MockedFunction<ReplayabilityService['evaluate']> =
    jest.fn();
  const replayability = {
    evaluate,
  } satisfies Pick<ReplayabilityService, 'evaluate'>;
  const getUnit: jest.MockedFunction<StoreganiseApiService['getUnit']> =
    jest.fn();
  const getUnitRental: jest.MockedFunction<
    StoreganiseApiService['getUnitRental']
  > = jest.fn();
  const updateUnit: jest.MockedFunction<StoreganiseApiService['updateUnit']> =
    jest.fn();
  const updateUnitRental: jest.MockedFunction<
    StoreganiseApiService['updateUnitRental']
  > = jest.fn();
  const sgApi = {
    getUnit,
    getUnitRental,
    updateUnit,
    updateUnitRental,
  } satisfies Pick<
    StoreganiseApiService,
    'getUnit' | 'getUnitRental' | 'updateUnit' | 'updateUnitRental'
  >;
  const moveInHandle: jest.MockedFunction<MoveInHandler['handle']> = jest.fn();
  const moveIn = {
    handle: moveInHandle,
  } satisfies Pick<MoveInHandler, 'handle'>;
  const moveOutHandle: jest.MockedFunction<MoveOutHandler['handle']> =
    jest.fn();
  const moveOut = {
    handle: moveOutHandle,
  } satisfies Pick<MoveOutHandler, 'handle'>;
  const overdueHandle: jest.MockedFunction<OverdueHandler['handle']> =
    jest.fn();
  const overdue = {
    handle: overdueHandle,
  } satisfies Pick<OverdueHandler, 'handle'>;
  const transferHandle: jest.MockedFunction<TransferHandler['handle']> =
    jest.fn();
  const transfer = {
    handle: transferHandle,
  } satisfies Pick<TransferHandler, 'handle'>;
  const userHandle: jest.MockedFunction<UserHandler['handle']> = jest.fn();
  const user = {
    handle: userHandle,
  } satisfies Pick<UserHandler, 'handle'>;
  const syncUnitWithRetry: jest.MockedFunction<
    UnitSyncHandler['syncUnitWithRetry']
  > = jest.fn();
  const unitSync = {
    syncUnitWithRetry,
  } satisfies Pick<UnitSyncHandler, 'syncUnitWithRetry'>;

  const scheduledJobRepo = {
    findById: jest.fn(),
    requeue: jest.fn(),
  };

  const createService = () =>
    new ReprocessService(
      syncLog as unknown as SyncLogService,
      replayability as unknown as ReplayabilityService,
      sgApi as unknown as StoreganiseApiService,
      moveIn as unknown as MoveInHandler,
      moveOut as unknown as MoveOutHandler,
      overdue as unknown as OverdueHandler,
      transfer as unknown as TransferHandler,
      user as unknown as UserHandler,
      unitSync as unknown as UnitSyncHandler,
      scheduledJobRepo as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    syncLog.add.mockResolvedValue(
      createSyncLogEntry({ id: 99, status: 'success' }),
    );
  });

  it('replays webhook failures via existing handler and writes a replay log', async () => {
    syncLog.getById.mockResolvedValue(
      createSyncLogEntry({
        id: 10,
        source: 'webhook',
        eventType: 'job.unit_moveIn.completed',
        payload: JSON.stringify({
          id: 'e1',
          type: 'job.unit_moveIn.completed',
          businessCode: 'b1',
          data: { jobId: 'j1' },
        }),
      }),
    );
    replayability.evaluate.mockReturnValue({
      replayable: true,
      replayReason: null,
    } satisfies ReplayDecision);
    moveIn.handle.mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      userName: 'Kim',
      stgUserId: 'u1',
      stgUnitId: 'unit1',
    });

    const result = await createService().reprocess(10);

    expect(moveIn.handle).toHaveBeenCalled();
    expect(syncLog.add).toHaveBeenCalledWith(
      expect.objectContaining({
        replayedFromLogId: 10,
        status: 'success',
      }),
      { suppressAlert: true, throwOnError: true },
    );
    expect(result).toEqual({ replayed: true, replayLogId: 99 });
  });

  it('replays site-sync failures via unit sync retry and writes a replay log', async () => {
    syncLog.getById.mockResolvedValue(
      createSyncLogEntry({
        id: 11,
        source: 'site-sync',
        eventType: 'unit.synced',
        payload: null,
        stgUnitId: 'unit-11',
      }),
    );
    replayability.evaluate.mockReturnValue({
      replayable: true,
      replayReason: null,
    } satisfies ReplayDecision);
    sgApi.getUnit.mockResolvedValue(createUnit('unit-11'));
    unitSync.syncUnitWithRetry.mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 2,
      userName: 'Lee',
      stgUserId: 'u2',
      stgUnitId: 'unit-11',
    });

    const result = await createService().reprocess(11);

    expect(sgApi.getUnit).toHaveBeenCalledWith('unit-11');
    expect(unitSync.syncUnitWithRetry).toHaveBeenCalledWith(
      createUnit('unit-11'),
    );
    expect(syncLog.add).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'site-sync',
        replayedFromLogId: 11,
        status: 'success',
      }),
      { suppressAlert: true, throwOnError: true },
    );
    expect(result).toEqual({ replayed: true, replayLogId: 99 });
  });

  it('reprocesses unit.updated via direct sync even when flag is no longer set', async () => {
    syncLog.getById.mockResolvedValue(
      createSyncLogEntry({
        id: 15,
        source: 'webhook',
        eventType: 'unit.updated',
        payload: JSON.stringify({
          id: 'e15',
          type: 'unit.updated',
          data: {
            unitId: 'unit-15',
            changedKeys: ['customFields.smartcube_syncUnit'],
          },
        }),
      }),
    );
    replayability.evaluate.mockReturnValue({
      replayable: true,
      replayReason: null,
    } satisfies ReplayDecision);
    sgApi.getUnit.mockResolvedValue(createUnit('unit-15'));
    sgApi.updateUnit.mockResolvedValue(createUnit('unit-15'));
    unitSync.syncUnitWithRetry.mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 15,
      stgUnitId: 'unit-15',
    });

    const result = await createService().reprocess(15);

    expect(unitSync.syncUnitWithRetry).toHaveBeenCalledWith(
      createUnit('unit-15'),
    );
    expect(sgApi.updateUnit).toHaveBeenCalledWith('unit-15', {
      customFields: { smartcube_syncUnit: false },
    });
    expect(result).toEqual({ replayed: true, replayLogId: 99 });
  });

  it('rejects non-replayable failures', async () => {
    syncLog.getById.mockResolvedValue(
      createSyncLogEntry({
        id: 12,
        source: 'scheduler',
        eventType: 'job.unit_moveOut.blocked',
        payload: null,
      }),
    );
    replayability.evaluate.mockReturnValue({
      replayable: false,
      replayReason: '재처리 불가',
    } satisfies ReplayDecision);

    await expect(createService().reprocess(12)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(syncLog.add).not.toHaveBeenCalled();
  });

  it('writes a replay error log when replay execution fails', async () => {
    syncLog.getById.mockResolvedValue(
      createSyncLogEntry({
        id: 13,
        source: 'webhook',
        eventType: 'job.unit_moveIn.completed',
        payload: JSON.stringify({
          id: 'e13',
          type: 'job.unit_moveIn.completed',
          data: { jobId: 'j13' },
        }),
      }),
    );
    replayability.evaluate.mockReturnValue({
      replayable: true,
      replayReason: null,
    } satisfies ReplayDecision);
    moveIn.handle.mockRejectedValue(new Error('db fail'));

    await expect(createService().reprocess(13)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(syncLog.add).toHaveBeenCalledWith(
      expect.objectContaining({
        replayedFromLogId: 13,
        status: 'error',
      }),
      { suppressAlert: true, throwOnError: true },
    );
  });

  it('fails reprocess when replay audit log write fails', async () => {
    syncLog.getById.mockResolvedValue(
      createSyncLogEntry({
        id: 17,
        source: 'webhook',
        eventType: 'job.unit_moveIn.completed',
        payload: JSON.stringify({
          id: 'e17',
          type: 'job.unit_moveIn.completed',
          data: { jobId: 'j17' },
        }),
      }),
    );
    replayability.evaluate.mockReturnValue({
      replayable: true,
      replayReason: null,
    } satisfies ReplayDecision);
    moveIn.handle.mockResolvedValue({} as SyncMeta);
    syncLog.add.mockRejectedValueOnce(new Error('insert fail'));

    await expect(createService().reprocess(17)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('replays scheduler failures by requeuing the schedule job and writing audit log', async () => {
    syncLog.getById.mockResolvedValue(
      createSyncLogEntry({
        id: 21,
        source: 'scheduler',
        eventType: 'job.unit_moveOut.blocked',
        payload: JSON.stringify({
          jobId: 555,
          scheduledAt: '2026-04-08T15:00:00.000Z',
        }),
      }),
    );
    replayability.evaluate.mockReturnValue({
      replayable: true,
      replayReason: null,
    } satisfies ReplayDecision);
    scheduledJobRepo.findById.mockResolvedValue({
      jobId: 555,
      status: 'failed',
    });
    scheduledJobRepo.requeue.mockResolvedValue(undefined);

    const result = await createService().reprocess(21);

    expect(scheduledJobRepo.findById).toHaveBeenCalledWith(555);
    expect(scheduledJobRepo.requeue).toHaveBeenCalledWith(555);
    expect(syncLog.add).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'scheduler',
        eventType: 'job.unit_moveOut.blocked',
        replayedFromLogId: 21,
        status: 'success',
        payload: { jobId: 555, requeued: true },
      }),
      { suppressAlert: true, throwOnError: true },
    );
    expect(result).toEqual({ replayed: true, replayLogId: 99 });
  });

  it('rejects scheduler reprocess when job not found in tblScheduledJob', async () => {
    syncLog.getById.mockResolvedValue(
      createSyncLogEntry({
        id: 22,
        source: 'scheduler',
        eventType: 'job.unit_moveIn.activated',
        payload: JSON.stringify({ jobId: 999 }),
      }),
    );
    replayability.evaluate.mockReturnValue({
      replayable: true,
      replayReason: null,
    } satisfies ReplayDecision);
    scheduledJobRepo.findById.mockResolvedValue(null);

    await expect(createService().reprocess(22)).rejects.toThrow(
      /찾을 수 없습니다/,
    );
    expect(scheduledJobRepo.requeue).not.toHaveBeenCalled();
  });

  it('rejects concurrent replay of the same log id', async () => {
    syncLog.getById.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ...createSyncLogEntry({
                  id: 14,
                  source: 'webhook',
                  eventType: 'job.unit_moveIn.completed',
                  payload: JSON.stringify({
                    id: 'e14',
                    type: 'job.unit_moveIn.completed',
                    data: { jobId: 'j14' },
                  }),
                }),
              }),
            25,
          ),
        ),
    );
    replayability.evaluate.mockReturnValue({
      replayable: true,
      replayReason: null,
    } satisfies ReplayDecision);
    moveIn.handle.mockResolvedValue({} as SyncMeta);

    const service = createService();
    const first = service.reprocess(14);
    await expect(service.reprocess(14)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await first;
  });
});
