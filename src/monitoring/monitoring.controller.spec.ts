import { MonitoringController } from './monitoring.controller';

describe('MonitoringController getLogs', () => {
  it('forwards q and parsed searchFields to syncLog.getAll', async () => {
    const syncLog = {
      getAll: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    const controller = new MonitoringController(
      syncLog as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await controller.getLogs(
      '20',
      '40',
      'webhook,user-sync',
      'error',
      '1018',
      'unitId,userName',
    );

    expect(syncLog.getAll).toHaveBeenCalledWith(
      20,
      40,
      ['webhook', 'user-sync'],
      'error',
      '1018',
      ['unitId', 'userName'],
      undefined,
    );
  });
});
