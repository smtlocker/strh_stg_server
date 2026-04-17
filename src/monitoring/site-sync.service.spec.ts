import { lastValueFrom, toArray } from 'rxjs';
import { SiteSyncService } from './site-sync.service';
import {
  SgUnit,
  StoreganiseApiService,
} from '../storeganise/storeganise-api.service';
import { UnitSyncHandler } from '../handlers/unit-sync.handler';
import { SyncLogService } from './sync-log.service';

describe('SiteSyncService', () => {
  const createService = () => {
    const sgApi = {
      getSiteIdByOfficeCode: jest.fn<Promise<string | null>, [string]>(),
      getUnitsForSite: jest.fn<Promise<SgUnit[]>, [string]>(),
      getActiveRentals: jest.fn<Promise<Record<string, unknown>[]>, []>().mockResolvedValue([]),
    };
    const unitSyncHandler = {
      syncUnit: jest.fn(),
    };
    const syncLog = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const stgUnitsCache = {
      getOrFetch: jest.fn().mockResolvedValue({ data: { groups: [] } }),
    };

    const service = new SiteSyncService(
      sgApi as unknown as StoreganiseApiService,
      unitSyncHandler as unknown as UnitSyncHandler,
      syncLog as unknown as SyncLogService,
      stgUnitsCache as unknown as import('./stg-units-cache.service').StgUnitsCacheService,
    );

    return { service, sgApi, unitSyncHandler, syncLog };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('groups, sorts, and canonicalizes Storeganise unit states', async () => {
    const { service, sgApi } = createService();
    sgApi.getSiteIdByOfficeCode.mockResolvedValue('site-1');
    sgApi.getActiveRentals.mockResolvedValue([
      { id: 'r-a2', siteId: 'site-1', customFields: { smartcube_lockStatus: 'overlocked' } } as Record<string, unknown>,
    ]);
    sgApi.getUnitsForSite.mockResolvedValue([
      {
        id: 'unit-a2',
        name: 'Unit A2',
        state: 'occupied',
        customFields: { smartcube_id: 'A:2' },
        rentalId: 'r-a2',
      } as SgUnit,
      {
        id: 'unit-a1',
        name: 'Unit A1',
        state: 'available',
        customFields: { smartcube_id: 'A:1' },
      } as SgUnit,
      {
        id: 'unit-a3',
        name: 'Unit A3',
        state: 'reserved',
        customFields: { smartcube_id: 'A:3' },
      } as SgUnit,
      {
        id: 'unit-a4',
        name: 'Unit A4',
        state: 'pre_completed',
        customFields: { smartcube_id: 'A:4' },
      } as SgUnit,
      {
        id: 'unit-b1',
        name: 'Unit B1',
        state: 'blocked',
        customFields: { smartcube_id: 'B:1' },
      } as SgUnit,
      {
        id: 'unit-b2',
        name: 'Unit B2',
        // state intentionally omitted → should default to 'available'
        customFields: { smartcube_id: 'B:2' },
      } as SgUnit,
      {
        id: 'ignored',
        name: 'Ignored',
        customFields: { smartcube_id: 'bad-id' },
      } as SgUnit,
    ]);

    await expect(service.getStgUnits('0001')).resolves.toEqual({
      groups: [
        {
          groupCode: 'A',
          units: [
            {
              showBoxNo: 1,
              unitId: 'unit-a1',
              name: 'Unit A1',
              state: 'available',
              overlocked: false,
              ownerName: '',
            },
            {
              showBoxNo: 2,
              unitId: 'unit-a2',
              name: 'Unit A2',
              state: 'occupied',
              overlocked: true,
              ownerName: '',
            },
            {
              showBoxNo: 3,
              unitId: 'unit-a3',
              name: 'Unit A3',
              state: 'available', // reserved → 빈칸
              overlocked: false,
              ownerName: '',
            },
            {
              showBoxNo: 4,
              unitId: 'unit-a4',
              name: 'Unit A4',
              state: 'available', // pre_completed → 빈칸
              overlocked: false,
              ownerName: '',
            },
          ],
        },
        {
          groupCode: 'B',
          units: [
            {
              showBoxNo: 1,
              unitId: 'unit-b1',
              name: 'Unit B1',
              // unit.state='blocked' → '차단(비매출 사용자)' 로 별도 표시
              state: 'blocked',
              overlocked: false,
              ownerName: '',
              nonRevenue: true,
            },
            {
              showBoxNo: 2,
              unitId: 'unit-b2',
              name: 'Unit B2',
              state: 'available', // missing state → 빈칸
              overlocked: false,
              ownerName: '',
            },
          ],
        },
      ],
    });
  });

  it('syncs only the requested group and unit filters', async () => {
    const { service, sgApi, unitSyncHandler, syncLog } = createService();
    sgApi.getSiteIdByOfficeCode.mockResolvedValue('site-1');
    sgApi.getUnitsForSite.mockResolvedValue([
      {
        id: 'unit-a1',
        name: 'Unit A1',
        customFields: { smartcube_id: 'A:1' },
      } as SgUnit,
      {
        id: 'unit-a2',
        name: 'Unit A2',
        customFields: { smartcube_id: 'A:2' },
      } as SgUnit,
      {
        id: 'unit-b1',
        name: 'Unit B1',
        customFields: { smartcube_id: 'B:1' },
      } as SgUnit,
    ]);
    unitSyncHandler.syncUnit.mockImplementation((unit: SgUnit) =>
      Promise.resolve({
        areaCode: 'strh00010001',
        showBoxNo: unit.id === 'unit-a2' ? 2 : 1,
        stgUnitId: unit.id,
      }),
    );

    const jobId = service.startSync('0001', ['B'], undefined, [
      { groupCode: 'A', showBoxNos: [2] },
    ]);
    const stream = service.getJobStream(jobId);
    if (!stream) {
      throw new Error('Expected a site sync stream for the created job');
    }

    const events = await lastValueFrom(stream.pipe(toArray()));

    expect(unitSyncHandler.syncUnit).toHaveBeenCalledTimes(2);
    expect(unitSyncHandler.syncUnit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'unit-a2' }),
    );
    expect(unitSyncHandler.syncUnit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'unit-b1' }),
    );
    expect(syncLog.add).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: 'complete',
        total: 2,
        succeeded: 2,
        failed: 0,
      }),
    );
  });
});
