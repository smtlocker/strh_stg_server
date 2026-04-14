/**
 * STG API 3회 재시도 + 최종 실패 알림 패턴 시연.
 *
 * sync-server의 핵심 회복 메커니즘:
 *  1. StoreganiseApiService.request() — 5xx/429/network 오류 시 지수 backoff(1s,2s)로
 *     최대 3회 재시도. 그 사이에 STG가 복구되면 호출자는 정상 응답을 받는다.
 *  2. 3회 모두 실패하면 StoreganiseApiException을 throw.
 *  3. 호출자(handler)가 에러를 잡아 SyncLogService.add({status:'error'})로 기록하면
 *     SyncLogService는 즉시 FailureAlertService.notifyFinalFailure()를 호출한다.
 *  4. FailureAlertService는 비-webhook 출처에 대해서 즉시 SMTP로 운영자 메일 발송.
 *
 * 이 spec은 위 흐름을 세 가지 시나리오로 실측 검증한다:
 *  - Case 1: 1회 실패 → 2회에서 성공 (재시도 1번 후 복구)
 *  - Case 2: 2회 실패 → 3회에서 성공 (재시도 2번 후 복구)
 *  - Case 3: 3회 실패 → 예외 + 운영자 이메일 발송
 */
import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { StoreganiseApiService } from './storeganise-api.service';
import { FailureAlertService } from '../monitoring/failure-alert.service';
import { DatabaseService } from '../database/database.service';
import { SyncLogEntry } from '../monitoring/monitoring.types';

jest.mock('nodemailer');

describe('STG API 3회 재시도 패턴 — 시연', () => {
  const mockSendMailGlobal = jest.fn().mockResolvedValue({ messageId: 'test' });
  let httpGet: jest.Mock;
  let httpPut: jest.Mock;
  let stg: StoreganiseApiService;

  /** 5xx 응답을 모방한 axios-shape error를 발행하는 observable */
  const fail500 = () =>
    throwError(() => {
      const err = new Error('Internal Server Error') as Error & {
        response: { status: number };
      };
      err.response = { status: 500 };
      return err;
    });

  const ok = <T>(data: T) => of({ data });

  beforeEach(() => {
    httpGet = jest.fn();
    httpPut = jest.fn();
    stg = new StoreganiseApiService({
      get: httpGet,
      put: httpPut,
    } as unknown as ConstructorParameters<typeof StoreganiseApiService>[0]);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    mockSendMailGlobal.mockReset().mockResolvedValue({ messageId: 'test' });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail: mockSendMailGlobal });
  });

  it('Case 1: 1회 실패 후 2회에서 성공 (재시도 1번 후 복구)', async () => {
    httpGet
      .mockReturnValueOnce(fail500())
      .mockReturnValueOnce(
        ok({ id: 'unit1', name: '1001', state: 'occupied' }),
      );

    const promise = stg.getUnit('unit1');
    // 1번째 시도 실패 → 1초 backoff
    await jest.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(httpGet).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: 'unit1', name: '1001', state: 'occupied' });
    // 최종 실패가 아니므로 이메일은 발송되지 않아야 함
    expect(mockSendMailGlobal).not.toHaveBeenCalled();
  });

  it('Case 2: 2회 실패 후 3회에서 성공 (재시도 2번 후 복구)', async () => {
    httpGet
      .mockReturnValueOnce(fail500())
      .mockReturnValueOnce(fail500())
      .mockReturnValueOnce(
        ok({ id: 'unit1', name: '1001', state: 'occupied' }),
      );

    const promise = stg.getUnit('unit1');
    // 1번째 실패 → 1초 backoff
    await jest.advanceTimersByTimeAsync(1000);
    // 2번째 실패 → 2초 backoff (1s * 2^1)
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(httpGet).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ id: 'unit1', name: '1001', state: 'occupied' });
    expect(mockSendMailGlobal).not.toHaveBeenCalled();
  });

  it('Case 3: 3회 모두 실패 → 예외 발생 + FailureAlert가 운영자에게 이메일 발송', async () => {
    httpGet
      .mockReturnValueOnce(fail500())
      .mockReturnValueOnce(fail500())
      .mockReturnValueOnce(fail500());

    // ── 1단계: STG API 3회 모두 실패 → StoreganiseApiException 발생 ──
    // .catch() 를 먼저 붙여둬야 advanceTimersByTimeAsync 진행 중 rejection 이
    // unhandled 로 새지 않음
    let stgError: Error | null = null;
    const settled = stg.getUnit('unit1').catch((err) => {
      stgError = err as Error;
    });
    await jest.advanceTimersByTimeAsync(1000); // 1번째 실패 후 backoff
    await jest.advanceTimersByTimeAsync(2000); // 2번째 실패 후 backoff
    // 3번째 실패는 backoff 없이 바로 throw
    await settled;

    expect(httpGet).toHaveBeenCalledTimes(3);
    expect(stgError).toBeTruthy();
    expect(stgError!.message).toMatch(
      /Storeganise API error: GET \/v1\/admin\/units\/unit1\?[^\s]* → 500/,
    );

    // ── 2단계: 호출자가 sync-log error를 기록 → FailureAlertService가 메일 발송 ──
    //
    // 운영 흐름: handler.catch → SyncLogService.add({status:'error'})
    //          → SyncLogService 가 enrichEntry 후 failureAlert.notifyFinalFailure() 호출
    // 시연을 위해 마지막 단계만 직접 호출.

    const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-id' });
    (require('nodemailer').createTransport as jest.Mock).mockReturnValue({
      sendMail: mockSendMail,
    });

    // FailureAlertService 의존성 stub
    const dbQuery = jest.fn(
      (sqlText: string, _params?: Record<string, unknown>) => {
        // wasAlertAlreadyHandled — 아직 알림 발송된 적 없음
        if (sqlText.includes('SELECT TOP 1 alertSentAt, alertStatus')) {
          return Promise.resolve({
            recordset: [{ alertSentAt: null, alertStatus: null }],
          });
        }
        // hasSentAlertForCorrelation — 같은 correlation 으로 발송된 알림 없음
        if (sqlText.includes("alertStatus = 'sent'")) {
          return Promise.resolve({ recordset: [{ cnt: 0 }] });
        }
        // markAlert UPDATE
        return Promise.resolve({ recordset: [] });
      },
    );
    const db = { query: dbQuery } as unknown as DatabaseService;

    const config = {
      get: () => ({
        from: 'SmartCube Alerts <noreply@hohorack.kr>',

        smtp: { host: 'smtp.test.com', port: 587, secure: false, user: 'u', pass: 'p' },
      }),
    } as unknown as ConfigService;

    const failureAlert = new FailureAlertService(config, db, {
      getSites: jest.fn().mockResolvedValue([
        { id: 'site-1', name: 'StorHub SG', code: 'storhub-sg', customFields: { admin_email: 'ops@hohorack.kr' } },
      ]),
    } as unknown as StoreganiseApiService);
    await failureAlert.onModuleInit();

    // SyncLogService 가 작성하는 것과 동일한 SyncLogEntry 모양으로 알림 트리거
    // 비-webhook 출처(site-sync)는 4초 grace 없이 즉시 발송
    const failedEntry: SyncLogEntry = {
      id: 999,
      source: 'site-sync',
      eventType: 'unit.synced',
      eventId: null,
      correlationKey: 'site-sync:unit.synced:unit1',
      businessCode: 'storhub-sg',
      areaCode: 'strh00010001',
      showBoxNo: 1,
      userName: null,
      stgUserId: null,
      stgUnitId: 'unit1',
      replayedFromLogId: null,
      status: 'error',
      durationMs: 0,
      error: stgError!.message,
      payload: null,
      createdAt: new Date('2026-04-07T05:00:00.000Z'),
      replayable: true,
      alertSentAt: null,
      alertStatus: null,
    };

    await failureAlert.notifyFinalFailure(failedEntry);

    // ── 검증: nodemailer sendMail 이 정확히 1회 호출 + 이메일 본문에 STG 에러가 포함 ──
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mailOptions = mockSendMail.mock.calls[0][0] as {
      from: string;
      to: string;
      subject: string;
      html: string;
    };
    expect(mailOptions.from).toBe('SmartCube Alerts <noreply@hohorack.kr>');
    expect(mailOptions.to).toBe('ops@hohorack.kr');
    expect(mailOptions.subject).toBe('[SmartCube] 실패 알림 - unit.synced');
    expect(mailOptions.html).toContain('Storeganise API error');
    expect(mailOptions.html).toContain('strh00010001');

    // markAlert('sent') 가 호출됐는지 (sync-log 에 alertStatus 갱신)
    const markCalls = dbQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('UPDATE tblSyncLog') &&
        call[1]?.status === 'sent',
    );
    expect(markCalls).toHaveLength(1);
  });
});
