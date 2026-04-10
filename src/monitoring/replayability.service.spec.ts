import { ReplayabilityService } from './replayability.service';

describe('ReplayabilityService', () => {
  const service = new ReplayabilityService();

  it('webhook error with payload is replayable', () => {
    const result = service.evaluate({
      status: 'error',
      source: 'webhook',
      eventType: 'job.unit_moveIn.completed',
      payload: { type: 'job.unit_moveIn.completed', data: { jobId: 'j1' } },
    } as any);

    expect(result).toEqual({ replayable: true, replayReason: null });
  });

  it('unit.updated is replayable only for smartcube_syncUnit with unitId', () => {
    const result = service.evaluate({
      status: 'error',
      source: 'webhook',
      eventType: 'unit.updated',
      payload: {
        type: 'unit.updated',
        data: {
          unitId: 'unit-1',
          changedKeys: ['customFields.smartcube_syncUnit'],
        },
      },
    } as any);

    expect(result).toEqual({ replayable: true, replayReason: null });
  });

  it('unitRental.updated is not replayable', () => {
    const result = service.evaluate({
      status: 'error',
      source: 'webhook',
      eventType: 'unitRental.updated',
      payload: {
        type: 'unitRental.updated',
        data: {
          unitRentalId: 'r1',
          changedKeys: ['customFields.smartcube_lockUnit'],
        },
      },
    } as any);

    expect(result.replayable).toBe(false);
  });

  it('scheduler error without jobId is not replayable', () => {
    const result = service.evaluate({
      status: 'error',
      source: 'scheduler',
      eventType: 'job.unit_moveOut.blocked',
      payload: {},
    } as any);

    expect(result.replayable).toBe(false);
    expect(result.replayReason).toContain('jobId');
  });

  it('scheduler error with jobId in payload is replayable', () => {
    const result = service.evaluate({
      status: 'error',
      source: 'scheduler',
      eventType: 'job.unit_moveOut.blocked',
      payload: { jobId: 42, scheduledAt: '2026-04-08T15:00:00.000Z' },
    } as any);

    expect(result).toEqual({ replayable: true, replayReason: null });
  });

  it('scheduler error with stringified payload jobId is replayable', () => {
    const result = service.evaluate({
      status: 'error',
      source: 'scheduler',
      eventType: 'job.unit_moveIn.activated',
      payload: JSON.stringify({ jobId: 99 }),
    } as any);

    expect(result).toEqual({ replayable: true, replayReason: null });
  });

  it('site-sync error without unitId is not replayable', () => {
    const result = service.evaluate({
      status: 'error',
      source: 'site-sync',
      eventType: 'unit.synced',
      payload: { officeCode: '0001' },
    } as any);

    expect(result.replayable).toBe(false);
  });

  it('site-sync error with stgUnitId metadata is replayable even without payload', () => {
    const result = service.evaluate({
      status: 'error',
      source: 'site-sync',
      eventType: 'unit.synced',
      payload: null,
      stgUnitId: 'unit-123',
    } as any);

    expect(result).toEqual({ replayable: true, replayReason: null });
  });
});
