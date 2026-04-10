import { DatabaseService } from '../database/database.service';
import { FailureAlertService } from './failure-alert.service';
import { ReplayabilityService } from './replayability.service';
import { SyncLogService } from './sync-log.service';

describe('SyncLogService getAll search', () => {
  it('builds OR search across selected fields and accepts user-sync source', async () => {
    const queryMock = jest
      .fn<
        ReturnType<DatabaseService['query']>,
        Parameters<DatabaseService['query']>
      >()
      .mockResolvedValueOnce({ recordset: [{ total: 1 }] } as never)
      .mockResolvedValueOnce({ recordset: [] } as never);
    const db = { query: queryMock };

    const service = new SyncLogService(
      db as unknown as DatabaseService,
      {} as unknown as ReplayabilityService,
      {} as unknown as FailureAlertService,
    );

    await service.getAll(10, 0, ['webhook', 'user-sync'], 'error', '1018', [
      'unitId',
      'userName',
    ]);

    expect(queryMock).toHaveBeenCalledTimes(2);

    const totalCall = queryMock.mock.calls[0];
    const itemsCall = queryMock.mock.calls[1];

    expect(totalCall[0]).toContain('source IN (@source0, @source1)');
    expect(totalCall[0]).toContain('status = @status');
    expect(totalCall[0]).toContain("ISNULL(userName, '') LIKE @searchTerm");
    expect(totalCall[0]).toContain(
      "ISNULL(CAST(showBoxNo AS NVARCHAR(20)), '') LIKE @searchTerm",
    );
    expect(totalCall[1]).toMatchObject({
      limit: 10,
      offset: 0,
      source0: 'webhook',
      source1: 'user-sync',
      status: 'error',
      searchTerm: '%1018%',
    });

    expect(itemsCall[0]).toContain(
      'ROW_NUMBER() OVER (ORDER BY createdAt DESC)',
    );
  });

  it('defaults to all search fields when searchFields is empty', async () => {
    const queryMock = jest
      .fn<
        ReturnType<DatabaseService['query']>,
        Parameters<DatabaseService['query']>
      >()
      .mockResolvedValueOnce({ recordset: [{ total: 0 }] } as never)
      .mockResolvedValueOnce({ recordset: [] } as never);
    const db = { query: queryMock };

    const service = new SyncLogService(
      db as unknown as DatabaseService,
      {} as unknown as ReplayabilityService,
      {} as unknown as FailureAlertService,
    );

    await service.getAll(10, 0, undefined, undefined, 'kim', []);

    const totalSql = queryMock.mock.calls[0][0];
    expect(totalSql).toContain('CAST(id AS NVARCHAR(50)) LIKE @searchTerm');
    expect(totalSql).toContain("ISNULL(stgUnitId, '') LIKE @searchTerm");
    expect(totalSql).toContain("ISNULL(stgUserId, '') LIKE @searchTerm");
  });
});
