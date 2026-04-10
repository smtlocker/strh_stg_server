/**
 * STG API 3회 재시도 + 실제 Resend 이메일 발송 시연 (LIVE).
 *
 * 이 spec 은 axios 를 mock 하지 않고 .env 의 RESEND_API_KEY 를 사용해서
 * 실제 Resend API 로 메일을 발송한다. 운영자의 받은편지함에 실제로 메일이 도착해야 한다.
 *
 * 실행 전 확인:
 *   - sync-server/.env 에 RESEND_API_KEY, FAILURE_ALERT_RECIPIENTS,
 *     FAILURE_ALERT_FROM, MONITORING_BASE_URL 가 설정되어 있어야 함
 *
 * 실행:
 *   npx jest src/storeganise/storeganise-api.service.retry.live.spec.ts
 *
 * 결과 확인:
 *   - Case 1, Case 2: 로그에서 retry 1/3, 2/3 메시지 확인. 메일 0통.
 *   - Case 3: 로그에서 retry 1/3, 2/3 + ERROR 확인. 메일 1통이 수신자에게 도착.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { StoreganiseApiService } from './storeganise-api.service';
import { FailureAlertService } from '../monitoring/failure-alert.service';
import { DatabaseService } from '../database/database.service';
import { SyncLogEntry } from '../monitoring/monitoring.types';

// .env 로딩 (sync-server 루트 기준)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const RESEND_KEY = process.env.RESEND_API_KEY ?? '';

// Resend 의 'onboarding@resend.dev' 테스트 도메인은 가입자 본인 이메일에만 발송 가능.
// 실제 운영자(jason@bybee.it) 으로 보내려면 도메인 verify 필요.
// 시연용 spec 이므로 가입자 이메일로 강제. .env 의 FAILURE_ALERT_RECIPIENTS 는 건드리지 않음.
const DEMO_RECIPIENT = 'bybeecode@gmail.com';
const RECIPIENTS = [DEMO_RECIPIENT];

const SENDER =
  process.env.FAILURE_ALERT_FROM ?? 'SmartCube Alerts <onboarding@resend.dev>';
const DASHBOARD_URL = process.env.MONITORING_BASE_URL ?? '';

// LIVE 발송 사전 조건: API 키 + 수신자 필수
const liveReady = !!RESEND_KEY && RECIPIENTS.length > 0;
const describeLive = liveReady ? describe : describe.skip;

describeLive('STG API 3회 재시도 + 실제 이메일 발송 (LIVE)', () => {
  let httpGet: jest.Mock;
  let httpPut: jest.Mock;
  let stg: StoreganiseApiService;

  /** 5xx 응답을 모방한 axios-shape error 를 발행하는 observable */
  const fail500 = () =>
    throwError(() => {
      const err = new Error('Internal Server Error') as Error & {
        response: { status: number };
      };
      err.response = { status: 500 };
      return err;
    });

  const ok = <T>(data: T) => of({ data });

  beforeAll(() => {
    console.log(
      `[LIVE] RESEND key=${RESEND_KEY.slice(0, 8)}…  recipients=${RECIPIENTS.join(',')}  dashboard=${DASHBOARD_URL}`,
    );
  });

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
  });

  it('Case 1: 1회 실패 후 2회에서 성공 (이메일 0통)', async () => {
    httpGet
      .mockReturnValueOnce(fail500())
      .mockReturnValueOnce(
        ok({ id: 'unit1', name: '1001', state: 'occupied' }),
      );

    const promise = stg.getUnit('unit1');
    await jest.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(httpGet).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: 'unit1', name: '1001', state: 'occupied' });
  });

  it('Case 2: 2회 실패 후 3회에서 성공 (이메일 0통)', async () => {
    httpGet
      .mockReturnValueOnce(fail500())
      .mockReturnValueOnce(fail500())
      .mockReturnValueOnce(
        ok({ id: 'unit1', name: '1001', state: 'occupied' }),
      );

    const promise = stg.getUnit('unit1');
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(httpGet).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ id: 'unit1', name: '1001', state: 'occupied' });
  });

  it('Case 3: 3회 모두 실패 → 운영자에게 실제 이메일 발송', async () => {
    httpGet
      .mockReturnValueOnce(fail500())
      .mockReturnValueOnce(fail500())
      .mockReturnValueOnce(fail500());

    // ── 1단계: STG API 3회 모두 실패 ──
    let stgError: Error | null = null;
    const settled = stg.getUnit('unit1').catch((err) => {
      stgError = err as Error;
    });
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);
    await settled;

    expect(httpGet).toHaveBeenCalledTimes(3);
    expect(stgError).toBeTruthy();
    expect(stgError!.message).toMatch(
      /Storeganise API error: GET \/v1\/admin\/units\/unit1\?[^\s]* → 500/,
    );

    // ── 2단계: FailureAlertService 가 실제 Resend API 로 메일 발송 ──
    // axios 가 mock 되어 있지 않으므로 실제 네트워크 호출 발생.

    // FailureAlertService 의 DB 의존성만 stub (시연용 sync-log row).
    const dbQuery = jest.fn(
      (sqlText: string, _params?: Record<string, unknown>) => {
        if (sqlText.includes('SELECT TOP 1 alertSentAt, alertStatus')) {
          return Promise.resolve({
            recordset: [{ alertSentAt: null, alertStatus: null }],
          });
        }
        if (sqlText.includes("alertStatus = 'sent'")) {
          return Promise.resolve({ recordset: [{ cnt: 0 }] });
        }
        return Promise.resolve({ recordset: [] });
      },
    );
    const db = { query: dbQuery } as unknown as DatabaseService;

    const config = {
      get: () => ({
        enabled: true,
        from: SENDER,
        smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
      }),
    } as unknown as ConfigService;

    const failureAlert = new FailureAlertService(config, db, {
      getSites: jest.fn().mockResolvedValue([]),
    } as unknown as StoreganiseApiService);

    // 시연 식별을 위한 타임스탬프
    const stamp = new Date().toISOString();

    const failedEntry: SyncLogEntry = {
      id: 999,
      source: 'site-sync',
      eventType: 'unit.synced',
      eventId: null,
      correlationKey: `site-sync:unit.synced:demo-${stamp}`,
      businessCode: null,
      areaCode: 'strh00010001',
      showBoxNo: 1,
      userName: '시연 사용자',
      stgUserId: 'demo-user',
      stgUnitId: 'unit1',
      replayedFromLogId: null,
      status: 'error',
      durationMs: 0,
      error: `[LIVE DEMO ${stamp}] ${stgError!.message}`,
      payload: null,
      createdAt: new Date(),
      replayable: true,
      alertSentAt: null,
      alertStatus: null,
    };

    // 실제 시간 사용 (axios 가 setTimeout 사용하지 않지만, 안전을 위해)
    jest.useRealTimers();

    await failureAlert.notifyFinalFailure(failedEntry);

    // 메일이 'sent' 상태로 마킹됐는지 (Resend 가 성공했다는 신호)
    const sentMarked = dbQuery.mock.calls.some(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('UPDATE tblSyncLog') &&
        call[1]?.status === 'sent',
    );

    if (!sentMarked) {
      // 디버깅: 어떤 status 로 마킹됐는지 확인
      const updateCalls = dbQuery.mock.calls
        .filter(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('UPDATE tblSyncLog'),
        )
        .map((call) => (call[1] as Record<string, unknown>)?.status);

      console.error(
        `[LIVE] 메일 발송 실패 — alertStatus 흐름: ${JSON.stringify(updateCalls)}`,
      );
    }

    expect(sentMarked).toBe(true);

    console.log(
      `[LIVE] ✓ Resend 발송 완료 — to=${RECIPIENTS.join(',')} subject="[SmartCube] 실패 알림 - unit.synced" stamp=${stamp}`,
    );
  });
});

if (!liveReady) {
  // 명시적인 안내 (jest 기본 출력은 skipped 만 표시)

  console.warn(
    `[LIVE] RESEND_API_KEY (${RESEND_KEY ? 'set' : 'missing'}) 또는 FAILURE_ALERT_RECIPIENTS (${RECIPIENTS.length}) 미설정 — live spec skipped`,
  );
}
