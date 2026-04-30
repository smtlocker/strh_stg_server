import { StgUnitsCacheService } from './stg-units-cache.service';
import { SiteSyncService } from './site-sync.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';

const makeServices = () => {
  const sgApi = {
    getActiveRentals: jest.fn(),
    getOfficeCode: jest.fn(),
    getSites: jest.fn(),
  };
  const siteSync = {
    getStgUnits: jest.fn(),
  };
  const service = new StgUnitsCacheService(
    siteSync as unknown as SiteSyncService,
    sgApi as unknown as StoreganiseApiService,
  );
  return { service, sgApi, siteSync };
};

const cachedEntry = (unitId: string, overlocked = false, state = 'occupied') => ({
  data: {
    groups: [
      {
        groupCode: 'A',
        units: [
          {
            showBoxNo: 1,
            unitId,
            name: 'A-1',
            state,
            overlocked,
            ownerName: '',
          },
        ],
      },
    ],
  },
  fetchedAt: new Date('2026-04-30T03:00:00.000Z'),
});

describe('StgUnitsCacheService', () => {
  describe('runDelta', () => {
    it('skips when cursor not bootstrapped', async () => {
      const { service, sgApi } = makeServices();
      await service.runDelta();
      expect(sgApi.getActiveRentals).not.toHaveBeenCalled();
    });

    it('calls getActiveRentals once with updatedAfter cursor', async () => {
      const { service, sgApi } = makeServices();
      (service as any).deltaCursor = new Date('2026-04-30T03:30:00.000Z');
      sgApi.getActiveRentals.mockResolvedValue([]);

      await service.runDelta();

      expect(sgApi.getActiveRentals).toHaveBeenCalledTimes(1);
      expect(sgApi.getActiveRentals).toHaveBeenCalledWith({
        updatedAfter: '2026-04-30T03:30:00.000Z',
      });
    });

    it('patches overlock change in cached entry in place', async () => {
      const { service, sgApi } = makeServices();
      (service as any).deltaCursor = new Date('2026-04-30T03:00:00.000Z');
      const entry = cachedEntry('unit-1', false);
      (service as any).cache.set('0001', entry);
      sgApi.getOfficeCode.mockResolvedValue('0001');
      sgApi.getActiveRentals.mockResolvedValue([
        {
          id: 'r1',
          unitId: 'unit-1',
          siteId: 'site-1',
          customFields: { smartcube_lockStatus: 'overlocked' },
        },
      ]);

      await service.runDelta();

      expect(entry.data.groups[0].units[0].overlocked).toBe(true);
    });

    it('triggers per-office fallback refresh when delta unit is not in cache', async () => {
      const { service, sgApi, siteSync } = makeServices();
      (service as any).deltaCursor = new Date('2026-04-30T03:00:00.000Z');
      const entry = cachedEntry('unit-existing');
      (service as any).cache.set('0001', entry);
      sgApi.getOfficeCode.mockResolvedValue('0001');
      sgApi.getActiveRentals.mockResolvedValue([
        {
          id: 'r-new',
          unitId: 'unit-new',
          siteId: 'site-1',
          customFields: {},
        },
      ]);
      siteSync.getStgUnits.mockResolvedValue({ groups: [] });

      await service.runDelta();
      // fallback refresh fires async — wait a tick
      await new Promise((r) => setImmediate(r));

      expect(siteSync.getStgUnits).toHaveBeenCalledTimes(1);
      expect(siteSync.getStgUnits).toHaveBeenCalledWith('0001', undefined);
    });

    it('retains existing cache when getActiveRentals throws', async () => {
      const { service, sgApi } = makeServices();
      (service as any).deltaCursor = new Date('2026-04-30T03:00:00.000Z');
      const entry = cachedEntry('unit-1');
      (service as any).cache.set('0001', entry);
      sgApi.getActiveRentals.mockRejectedValue(new Error('STG 500'));

      await service.runDelta();

      expect((service as any).cache.get('0001')).toBe(entry);
    });
  });

  describe('runFullSweep', () => {
    it('fetches active rentals once and reuses across all offices', async () => {
      const { service, sgApi, siteSync } = makeServices();
      sgApi.getSites.mockResolvedValue([
        { id: 's1', customFields: { smartcube_siteCode: '001' } },
        { id: 's2', customFields: { smartcube_siteCode: '002' } },
      ]);
      const prefetched = [{ id: 'r1', unitId: 'u1', siteId: 's1' }];
      sgApi.getActiveRentals.mockResolvedValue(prefetched);
      siteSync.getStgUnits.mockResolvedValue({ groups: [] });

      await service.runFullSweep();

      expect(sgApi.getActiveRentals).toHaveBeenCalledTimes(1);
      expect(siteSync.getStgUnits).toHaveBeenCalledTimes(2);
      expect(siteSync.getStgUnits).toHaveBeenNthCalledWith(1, '0001', prefetched);
      expect(siteSync.getStgUnits).toHaveBeenNthCalledWith(2, '0002', prefetched);
      expect((service as any).deltaCursor).toBeInstanceOf(Date);
    });

    it('retains existing cache when getActiveRentals throws', async () => {
      const { service, sgApi, siteSync } = makeServices();
      (service as any).officeCodes = ['0001'];
      const entry = cachedEntry('unit-1');
      (service as any).cache.set('0001', entry);
      sgApi.getActiveRentals.mockRejectedValue(new Error('STG 500'));

      await service.runFullSweep();

      expect(siteSync.getStgUnits).not.toHaveBeenCalled();
      expect((service as any).cache.get('0001')).toBe(entry);
    });
  });

  describe('invalidate (5s leading-edge debounce per officeCode)', () => {
    let nowSpy: jest.SpyInstance;
    let currentNow = 1_000_000;
    beforeEach(() => {
      currentNow = 1_000_000;
      nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => currentNow);
    });
    afterEach(() => {
      nowSpy.mockRestore();
    });

    it('first invalidate triggers refresh', () => {
      const { service, siteSync } = makeServices();
      siteSync.getStgUnits.mockResolvedValue({ groups: [] });

      service.invalidate('0001');

      expect(siteSync.getStgUnits).toHaveBeenCalledTimes(1);
    });

    it('subsequent invalidate within 5s for same office is dropped', () => {
      const { service, siteSync } = makeServices();
      siteSync.getStgUnits.mockResolvedValue({ groups: [] });

      service.invalidate('0001');
      currentNow += 2_000;
      service.invalidate('0001');
      service.invalidate('0001');

      expect(siteSync.getStgUnits).toHaveBeenCalledTimes(1);
    });

    it('different officeCodes are debounced independently', () => {
      const { service, siteSync } = makeServices();
      siteSync.getStgUnits.mockResolvedValue({ groups: [] });

      service.invalidate('0001');
      service.invalidate('0002');

      expect(siteSync.getStgUnits).toHaveBeenCalledTimes(2);
    });

    it('after the 5s window expires, next invalidate triggers refresh again', async () => {
      const { service, siteSync } = makeServices();
      siteSync.getStgUnits.mockResolvedValue({ groups: [] });

      service.invalidate('0001');
      // Let the first refresh's microtask chain settle so inFlight clears
      // before the second invalidate (otherwise dedup returns the same promise).
      await new Promise((resolve) => setImmediate(resolve));
      currentNow += 5_001;
      service.invalidate('0001');

      expect(siteSync.getStgUnits).toHaveBeenCalledTimes(2);
    });
  });
});
