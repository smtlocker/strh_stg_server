import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { DatabaseService } from '../database/database.service';
import { MonitoringAuthService } from './monitoring-auth.service';

const createConfig = (
  overrides?: Partial<Record<string, string | number>>,
): Pick<ConfigService, 'get'> => ({
  get: jest.fn((key: string) => {
    const defaults: Record<string, string | number> = {
      'monitoringAuth.cookieName': 'smartcube_monitoring_session',
      'monitoringAuth.sessionTtlMs': 1000,
      'monitoringAuth.cookieSecure': 'auto',
    };
    return overrides?.[key] ?? defaults[key];
  }),
});

const createResponse = (): Pick<Response, 'append'> => ({
  append: jest.fn(),
});

describe('MonitoringAuthService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('validates enabled accounts through tblMgrAccnt', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({ recordset: [{ MgrId: 'admin' }] }),
    } satisfies Pick<DatabaseService, 'query'>;
    const service = new MonitoringAuthService(
      createConfig() as ConfigService,
      db as unknown as DatabaseService,
    );

    await expect(
      service.validateCredentials('admin', 'secret'),
    ).resolves.toEqual({ mgrId: 'admin' });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM tblMgrAccnt'),
      { mgrId: 'admin', mgrPwd: 'secret' },
    );
  });

  it('rejects blank credentials before querying DB', async () => {
    const db = {
      query: jest.fn(),
    } satisfies Pick<DatabaseService, 'query'>;
    const service = new MonitoringAuthService(
      createConfig() as ConfigService,
      db as unknown as DatabaseService,
    );

    await expect(service.validateCredentials('', 'secret')).resolves.toBeNull();
    await expect(service.validateCredentials('admin', '')).resolves.toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('creates distinct sessions and expires stale ones', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);

    const service = new MonitoringAuthService(
      createConfig({ 'monitoringAuth.sessionTtlMs': 500 }) as ConfigService,
      { query: jest.fn() } as unknown as DatabaseService,
    );
    const first = service.createSession('admin');
    const second = service.createSession('admin');

    expect(first.id).not.toBe(second.id);

    nowSpy.mockReturnValue(1_501);
    const expired = service.getSessionFromRequest({
      headers: { cookie: `smartcube_monitoring_session=${first.id}` },
    } as Request);
    expect(expired).toBeNull();
  });

  it('removes an existing request session before re-login replacement', () => {
    const service = new MonitoringAuthService(
      createConfig() as ConfigService,
      { query: jest.fn() } as unknown as DatabaseService,
    );
    const first = service.createSession('admin');

    expect(
      service.destroySessionFromRequest({
        headers: { cookie: `smartcube_monitoring_session=${first.id}` },
      } as Request),
    ).toBe(true);
    expect(
      service.getSessionFromRequest({
        headers: { cookie: `smartcube_monitoring_session=${first.id}` },
      } as Request),
    ).toBeNull();
  });

  it('sets and clears session cookies with expected flags', () => {
    const service = new MonitoringAuthService(
      createConfig({
        'monitoringAuth.cookieSecure': 'always',
      }) as ConfigService,
      { query: jest.fn() } as unknown as DatabaseService,
    );
    const response = createResponse();
    const request = { headers: {} } as Request;

    service.setSessionCookie(response as Response, request, 'session-1');
    service.clearSessionCookie(response as Response, request);

    const append = response.append as jest.Mock;
    const calls = append.mock.calls as Array<[string, string]>;
    const setCookie = calls[0][1];
    const clearCookie = calls[1][1];

    expect(setCookie).toContain('smartcube_monitoring_session=session-1');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    expect(clearCookie).toContain('Max-Age=0');
    expect(clearCookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });

  it('sets Secure cookie only when req.secure is true in auto mode', () => {
    const service = new MonitoringAuthService(
      createConfig() as ConfigService,
      { query: jest.fn() } as unknown as DatabaseService,
    );

    const secureResponse = createResponse();
    service.setSessionCookie(
      secureResponse as Response,
      { secure: true, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as Request,
      'secure-session',
    );
    const secureCalls = (secureResponse.append as jest.Mock).mock.calls as Array<[string, string]>;
    expect(secureCalls[0][1]).toContain('Secure');

    const insecureResponse = createResponse();
    service.setSessionCookie(
      insecureResponse as Response,
      { secure: false, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as Request,
      'insecure-session',
    );
    const insecureCalls = (insecureResponse.append as jest.Mock).mock.calls as Array<[string, string]>;
    expect(insecureCalls[0][1]).not.toContain('Secure');
  });

  it('sanitizes next paths to stay within monitoring HTML routes', () => {
    const service = new MonitoringAuthService(
      createConfig() as ConfigService,
      { query: jest.fn() } as unknown as DatabaseService,
    );

    expect(service.sanitizeNextPath('/monitoring')).toBe('/monitoring');
    expect(service.sanitizeNextPath('/monitoring?tab=logs')).toBe(
      '/monitoring?tab=logs',
    );
    expect(service.sanitizeNextPath('/monitoring#feed')).toBe(
      '/monitoring#feed',
    );
    expect(service.sanitizeNextPath('/monitoring/api/stats')).toBe(
      '/monitoring',
    );
    expect(service.sanitizeNextPath('/monitoringevil')).toBe('/monitoring');
    expect(service.sanitizeNextPath('https://example.com')).toBe('/monitoring');
  });
});
