import { of } from 'rxjs';
import { StoreganiseApiService } from './storeganise-api.service';

describe('StoreganiseApiService', () => {
  it('getUnitsForSite paginates until the final partial page', async () => {
    const get = jest
      .fn()
      .mockReturnValueOnce(
        of({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `u${i}` })) }),
      )
      .mockReturnValueOnce(of({ data: [{ id: 'u1000' }, { id: 'u1001' }] }));

    const service = new StoreganiseApiService({ get } as any);

    const units = await service.getUnitsForSite('site1');

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][0]).toContain(
      '/v1/admin/units?siteId=site1&include=customFields&limit=1000&offset=0',
    );
    expect(get.mock.calls[1][0]).toContain(
      '/v1/admin/units?siteId=site1&include=customFields&limit=1000&offset=1000',
    );
    expect(units).toHaveLength(1002);
  });

  describe('getActiveRentals', () => {
    it('without args performs full sweep (no updatedAfter in query)', async () => {
      const get = jest.fn().mockReturnValueOnce(of({ data: [] }));
      const service = new StoreganiseApiService({ get } as any);

      await service.getActiveRentals();

      expect(get).toHaveBeenCalledTimes(1);
      expect(get.mock.calls[0][0]).toContain(
        '/v1/admin/unit-rentals?state=active&limit=1000&offset=0&include=customFields',
      );
      expect(get.mock.calls[0][0]).not.toContain('updatedAfter');
    });

    it('with opts.updatedAfter appends URI-encoded ISO timestamp', async () => {
      const get = jest.fn().mockReturnValueOnce(of({ data: [] }));
      const service = new StoreganiseApiService({ get } as any);

      await service.getActiveRentals({
        updatedAfter: '2026-04-30T00:00:00.000Z',
      });

      expect(get.mock.calls[0][0]).toContain(
        'updatedAfter=2026-04-30T00%3A00%3A00.000Z',
      );
    });
  });

  describe('getSites cache (1h TTL)', () => {
    it('returns cached array within TTL without re-fetching', async () => {
      const get = jest
        .fn()
        .mockReturnValueOnce(of({ data: [{ id: 's1', name: 'Site 1' }] }));
      const service = new StoreganiseApiService({ get } as any);

      const a = await service.getSites();
      const b = await service.getSites();

      expect(a).toBe(b);
      expect(get).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after the 1h TTL expires', async () => {
      jest.useFakeTimers();
      try {
        const get = jest
          .fn()
          .mockReturnValueOnce(of({ data: [{ id: 's1', name: 'Site 1' }] }))
          .mockReturnValueOnce(
            of({
              data: [
                { id: 's1', name: 'Site 1' },
                { id: 's2', name: 'Site 2' },
              ],
            }),
          );
        const service = new StoreganiseApiService({ get } as any);

        const first = await service.getSites();
        expect(first).toHaveLength(1);

        jest.advanceTimersByTime(60 * 60 * 1000 + 1000); // TTL + 1s
        const second = await service.getSites();
        expect(second).toHaveLength(2);
        expect(get).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
