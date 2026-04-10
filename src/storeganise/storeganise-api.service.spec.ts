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
});
