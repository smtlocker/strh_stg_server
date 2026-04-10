import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, lastValueFrom, throwError } from 'rxjs';
import { SyncLogService } from './sync-log.service';
import { WebhookLogInterceptor } from './webhook-log.interceptor';
import { WebhookHandleResult } from '../webhook/webhook.service';
import { ScheduledJobRepository } from '../scheduler/scheduled-job.repository';

describe('WebhookLogInterceptor', () => {
  const createInterceptor = () => {
    const syncLog = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const scheduledJobRepo = {
      createWithoutTransaction: jest.fn().mockResolvedValue(1),
    };

    return {
      interceptor: new WebhookLogInterceptor(
        syncLog as unknown as SyncLogService,
        scheduledJobRepo as unknown as ScheduledJobRepository,
      ),
      syncLog,
      scheduledJobRepo,
    };
  };

  const createContext = (
    body: Record<string, unknown>,
    omxWebhookLog?: WebhookHandleResult,
  ) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ body, omxWebhookLog }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs successful webhook requests with sync metadata', async () => {
    const { interceptor, syncLog } = createInterceptor();
    const context = createContext(
      {
        id: 'evt-1',
        type: 'unit.updated',
        businessCode: 'biz-1',
      },
      {
        syncMeta: {
          areaCode: 'strh00010001',
          showBoxNo: 1,
          userName: 'Kim',
          stgUserId: 'user-1',
          stgUnitId: 'unit-1',
        },
      },
    );
    const next = { handle: () => of({ ok: true }) } as CallHandler;

    await lastValueFrom(interceptor.intercept(context, next));

    expect(syncLog.add).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'webhook',
        status: 'success',
        eventType: 'unit.updated',
        eventId: 'evt-1',
        businessCode: 'biz-1',
        areaCode: 'strh00010001',
        showBoxNo: 1,
        userName: 'Kim',
        stgUserId: 'user-1',
        stgUnitId: 'unit-1',
      }),
    );
  });

  it('skips logging when the payload is marked with _skipLog', async () => {
    const { interceptor, syncLog } = createInterceptor();
    const context = createContext(
      {
        type: 'unit.updated',
      },
      { skipLog: true },
    );
    const next = { handle: () => of({ ok: true }) } as CallHandler;

    await lastValueFrom(interceptor.intercept(context, next));

    expect(syncLog.add).not.toHaveBeenCalled();
  });

  it('logs failed webhook requests, schedules retry, and rethrows the original error', async () => {
    const { interceptor, syncLog, scheduledJobRepo } = createInterceptor();
    const context = createContext(
      {
        id: 'evt-2',
        type: 'user.updated',
      },
      {
        syncMeta: { stgUserId: 'user-2' },
      },
    );
    const next = {
      handle: () => throwError(() => new Error('boom')),
    } as CallHandler;

    await expect(
      lastValueFrom(interceptor.intercept(context, next)),
    ).rejects.toThrow('boom');
    expect(syncLog.add).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'webhook',
        status: 'error',
        eventType: 'user.updated',
        eventId: 'evt-2',
        stgUserId: 'user-2',
        error: 'boom',
      }),
      { suppressAlert: true },
    );
    expect(scheduledJobRepo.createWithoutTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'webhook.retry',
        maxAttempts: 3,
        correlationKey: 'webhook-retry:user.updated:evt-2',
        sourceEventType: 'user.updated',
        sourceEventId: 'evt-2',
      }),
    );
  });

  it('does not mutate the original request body with internal logging flags', async () => {
    const { interceptor } = createInterceptor();
    const body = {
      id: 'evt-3',
      type: 'unit.updated',
    };
    const context = createContext(body, {
      skipLog: true,
      syncMeta: { stgUserId: 'user-3' },
    });
    const next = { handle: () => of({ ok: true }) } as CallHandler;

    await lastValueFrom(interceptor.intercept(context, next));

    expect(body).toEqual({
      id: 'evt-3',
      type: 'unit.updated',
    });
  });
});
