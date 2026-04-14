import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { SyncLogEntry } from './monitoring.types';
import { FailureAlertService } from './failure-alert.service';

jest.mock('nodemailer');

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-id' });
(nodemailer.createTransport as jest.Mock).mockReturnValue({
  sendMail: mockSendMail,
});

describe('FailureAlertService', () => {
  const getConfig = jest.fn(() => ({
    from: 'SmartCube Alerts <alerts@smartlocker.co.kr>',

    smtp: { host: 'smtp.test.com', port: 587, secure: false, user: 'u', pass: 'p' },
  }));
  const configService = {
    get: getConfig as ConfigService['get'],
  };
  type QueryResult = { recordset: Array<Record<string, unknown>> };
  const query = jest.fn<
    Promise<QueryResult>,
    [sqlText: string, params?: Record<string, unknown>]
  >();
  const mockDb = { query };
  const mockStgApi = {
    getSites: jest.fn().mockResolvedValue([
      { id: 'site-1', name: 'Test Site', code: 'test-biz', customFields: { admin_email: 'ops@test.com' } },
    ]),
  };

  type RowState = {
    id: number;
    source: 'webhook' | 'site-sync';
    eventType: string;
    correlationKey: string | null;
    alertStatus: string | null;
    alertSentAt: Date | null;
    areaCode?: string;
    showBoxNo?: number;
    error?: string;
    replayable?: boolean;
    createdAt?: Date;
  };

  const setupDb = (
    row: RowState,
    options?: { successCnt?: number; sentCnt?: number },
  ) => {
    query.mockImplementation(
      (sqlText: string, params?: Record<string, unknown>) => {
        if (typeof sqlText !== 'string') {
          return Promise.resolve({ recordset: [] });
        }

        if (
          sqlText.includes('SELECT TOP 1') &&
          sqlText.includes('FROM tblSyncLog') &&
          sqlText.includes('correlationKey')
        ) {
          return Promise.resolve({
            recordset: [
              {
                id: row.id,
                source: row.source,
                eventType: row.eventType,
                correlationKey: row.correlationKey,
                businessCode: 'test-biz',
                alertStatus: row.alertStatus,
                alertSentAt: row.alertSentAt,
                areaCode: row.areaCode ?? null,
                showBoxNo: row.showBoxNo ?? null,
                error: row.error ?? null,
                replayable: row.replayable ?? false,
                createdAt: row.createdAt ?? new Date(),
              },
            ],
          });
        }

        if (sqlText.includes('SELECT TOP 1 alertSentAt, alertStatus')) {
          return Promise.resolve({
            recordset: [
              {
                alertSentAt: row.alertSentAt,
                alertStatus: row.alertStatus,
              },
            ],
          });
        }

        if (sqlText.includes("status = 'success'")) {
          return Promise.resolve({
            recordset: [{ cnt: options?.successCnt ?? 0 }],
          });
        }

        if (sqlText.includes("alertStatus = 'sent'")) {
          return Promise.resolve({
            recordset: [{ cnt: options?.sentCnt ?? 0 }],
          });
        }

        const status =
          typeof params?.status === 'string' ? params.status : undefined;
        if (sqlText.includes('UPDATE tblSyncLog') && status) {
          row.alertStatus = status;
          if (status === 'sent') {
            row.alertSentAt = new Date();
          }
        }

        return Promise.resolve({ recordset: [] });
      },
    );
  };

  const toSyncLogEntry = (row: RowState): SyncLogEntry => ({
    id: row.id,
    source: row.source,
    eventType: row.eventType,
    eventId: null,
    correlationKey: row.correlationKey,
    businessCode: 'test-biz',
    areaCode: row.areaCode ?? null,
    showBoxNo: row.showBoxNo ?? null,
    userName: null,
    stgUserId: null,
    stgUnitId: null,
    status: 'error',
    durationMs: 0,
    error: row.error ?? null,
    payload: null,
    createdAt: row.createdAt ?? new Date(),
    replayable: row.replayable ?? false,
    alertSentAt: row.alertSentAt,
    alertStatus: row.alertStatus,
  });

  const createService = async () => {
    const svc = new FailureAlertService(
      configService as unknown as ConfigService,
      mockDb as unknown as DatabaseService,
      mockStgApi as unknown as StoreganiseApiService,
    );
    await svc.onModuleInit();
    return svc;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockSendMail.mockResolvedValue({ messageId: 'test-id' });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({
      sendMail: mockSendMail,
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('sends email immediately for non-webhook final failures', async () => {
    const row: RowState = {
      id: 1,
      source: 'site-sync',
      eventType: 'unit.synced',
      correlationKey: 'site-sync:unit.synced:unit-1',
      alertStatus: null,
      alertSentAt: null,
      areaCode: 'strh00010001',
      showBoxNo: 1,
      error: 'boom',
      replayable: true,
    };
    setupDb(row);

    const svc = await createService();
    await svc.notifyFinalFailure(toSyncLogEntry(row));

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(row.alertStatus).toBe('sent');
    expect(row.alertSentAt).toBeInstanceOf(Date);
  });

  it('marks webhook failures pending before delayed finalization', async () => {
    const row: RowState = {
      id: 2,
      source: 'webhook',
      eventType: 'job.unit_moveIn.completed',
      correlationKey: 'webhook:job.unit_moveIn.completed:e2',
      alertStatus: null,
      alertSentAt: null,
    };
    setupDb(row);

    const svc = await createService();
    await svc.notifyFinalFailure(toSyncLogEntry(row));

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(row.alertStatus).toBe('pending-webhook-retry');
  });

  it('suppresses webhook alert when retry succeeds within grace window', async () => {
    const row: RowState = {
      id: 3,
      source: 'webhook',
      eventType: 'job.unit_moveIn.completed',
      correlationKey: 'webhook:job.unit_moveIn.completed:e3',
      alertStatus: null,
      alertSentAt: null,
    };
    setupDb(row, { successCnt: 1 });

    const svc = await createService();
    await svc.notifyFinalFailure(toSyncLogEntry(row));
    await jest.advanceTimersByTimeAsync(4000);

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(row.alertStatus).toBe('suppressed');
  });

  it('sends webhook alert only after grace window when retry did not recover', async () => {
    const row: RowState = {
      id: 4,
      source: 'webhook',
      eventType: 'job.unit_moveIn.completed',
      correlationKey: 'webhook:job.unit_moveIn.completed:e4',
      alertStatus: null,
      alertSentAt: null,
      areaCode: 'strh00010001',
      showBoxNo: 4,
      error: 'boom',
      replayable: true,
    };
    setupDb(row, { successCnt: 0, sentCnt: 0 });

    const svc = await createService();
    await svc.notifyFinalFailure(toSyncLogEntry(row));
    await jest.advanceTimersByTimeAsync(4000);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(row.alertStatus).toBe('sent');
  });

  it('marks missing-smtp-config when SMTP is not configured', async () => {
    getConfig.mockReturnValueOnce({
      from: 'SmartCube Alerts <alerts@smartlocker.co.kr>',

      smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
    });
    const row: RowState = {
      id: 5,
      source: 'site-sync',
      eventType: 'unit.synced',
      correlationKey: 'site-sync:unit.synced:unit-5',
      alertStatus: null,
      alertSentAt: null,
    };
    setupDb(row);

    const svc = await createService();
    await svc.notifyFinalFailure(toSyncLogEntry(row));

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(row.alertStatus).toBe('missing-smtp-config');
  });

  it('sends to site admin_email when businessCode matches a site', async () => {
    mockStgApi.getSites.mockResolvedValue([
      {
        id: 'site-1',
        name: 'Pioneer 6',
        code: 'biz-A',
        customFields: { admin_email: 'site-admin@example.com' },
      },
    ]);
    const row: RowState = {
      id: 6,
      source: 'site-sync',
      eventType: 'unit.synced',
      correlationKey: 'site-sync:unit.synced:unit-6',
      alertStatus: null,
      alertSentAt: null,
      error: 'boom',
    };
    setupDb(row);

    const svc = await createService();
    const entry = toSyncLogEntry(row);
    entry.businessCode = 'biz-A';
    await svc.notifyFinalFailure(entry);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0] as { to: string };
    expect(call.to).toBe('site-admin@example.com');
    expect(row.alertStatus).toBe('sent');
  });

  it('marks no-recipients when site has no admin_email', async () => {
    mockStgApi.getSites.mockResolvedValue([
      { id: 'site-2', name: 'Some Site', code: 'biz-B', customFields: {} },
    ]);
    const row: RowState = {
      id: 7,
      source: 'site-sync',
      eventType: 'unit.synced',
      correlationKey: 'site-sync:unit.synced:unit-7',
      alertStatus: null,
      alertSentAt: null,
      error: 'boom',
    };
    setupDb(row);

    const svc = await createService();
    const entry = toSyncLogEntry(row);
    entry.businessCode = 'biz-B';
    await svc.notifyFinalFailure(entry);

    expect(mockSendMail).not.toHaveBeenCalled();
    const markCalls = query.mock.calls.filter(
      (c) =>
        typeof c[0] === 'string' &&
        c[0].includes('UPDATE tblSyncLog') &&
        c[1]?.status === 'no-recipients',
    );
    expect(markCalls).toHaveLength(1);
  });
});
