import { WebhookService } from './webhook.service';

describe('WebhookService', () => {
  const mockDb = {
    query: jest.fn().mockResolvedValue({ recordset: [{ cnt: 0 }] }),
  } as any;
  const moveInHandler = { handle: jest.fn() } as any;
  const moveOutHandler = { handle: jest.fn() } as any;
  const overdueHandler = { handle: jest.fn() } as any;
  const rentalUpdatedHandler = { handle: jest.fn() } as any;
  const userHandler = { handle: jest.fn() } as any;
  const transferHandler = { handle: jest.fn() } as any;
  const unitSyncHandler = { handle: jest.fn() } as any;
  const stgUnitsCache = { invalidate: jest.fn() } as any;

  const createService = () =>
    new WebhookService(
      mockDb,
      moveInHandler,
      moveOutHandler,
      overdueHandler,
      rentalUpdatedHandler,
      userHandler,
      transferHandler,
      unitSyncHandler,
      stgUnitsCache,
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns skipLog instead of mutating payload when unit.updated is irrelevant', async () => {
    const payload = {
      type: 'unit.updated',
      data: { changedKeys: ['customFields.other'] },
    } as any;

    const result = await createService().handle(payload);

    expect(result).toEqual({ skipLog: true });
    expect(payload._skipLog).toBeUndefined();
    expect(unitSyncHandler.handle).not.toHaveBeenCalled();
  });

  it('wraps handler sync meta without mutating payload', async () => {
    unitSyncHandler.handle.mockResolvedValue({
      areaCode: 'strh00010001',
      showBoxNo: 1,
      stgUnitId: 'unit-1',
    });

    const payload = {
      type: 'unit.updated',
      data: { changedKeys: ['customFields.smartcube_syncUnit'] },
    } as any;

    const result = await createService().handle(payload);

    expect(result).toEqual({
      syncMeta: {
        areaCode: 'strh00010001',
        showBoxNo: 1,
        stgUnitId: 'unit-1',
      },
    });
    expect(payload._skipLog).toBeUndefined();
    expect(unitSyncHandler.handle).toHaveBeenCalledWith(payload);
  });
});
