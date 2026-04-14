import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

  // setSessionCookie / clearSessionCookie 는 메인 Path=/ cookie 외에 과거
  // Path=/monitoring 으로 발급된 stale cookie 를 명시적으로 무효화하는 헤더를
  // 함께 발급한다. 테스트는 메인 cookie 만 검증.
  const mainCookies = (response: Pick<Response, 'append'>): string[] =>
    ((response.append as jest.Mock).mock.calls as Array<[string, string]>)
      .map(([, header]) => header)
      .filter((header) => !header.includes('Path=/monitoring'));

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

    const [setCookie, clearCookie] = mainCookies(response);

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
    expect(mainCookies(secureResponse)[0]).toContain('Secure');

    const insecureResponse = createResponse();
    service.setSessionCookie(
      insecureResponse as Response,
      { secure: false, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as Request,
      'insecure-session',
    );
    expect(mainCookies(insecureResponse)[0]).not.toContain('Secure');
  });

  it('persists sessions to disk and rehydrates them on next instance', () => {
    const storePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'smartcube-sessions-')),
      'sessions.json',
    );
    process.env.MONITORING_SESSION_STORE = storePath;

    try {
      const first = new MonitoringAuthService(
        createConfig({
          'monitoringAuth.sessionStore': storePath,
        }) as ConfigService,
        { query: jest.fn() } as unknown as DatabaseService,
      );
      const session = first.createSession('admin');
      first.flushSessionsToDisk();

      expect(fs.existsSync(storePath)).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(storePath, 'utf8')) as unknown[];
      expect(persisted).toHaveLength(1);

      const second = new MonitoringAuthService(
        createConfig({
          'monitoringAuth.sessionStore': storePath,
        }) as ConfigService,
        { query: jest.fn() } as unknown as DatabaseService,
      );
      const restored = second.getSessionFromRequest({
        headers: { cookie: `smartcube_monitoring_session=${session.id}` },
      } as Request);

      expect(restored).not.toBeNull();
      expect(restored?.mgrId).toBe('admin');
    } finally {
      delete process.env.MONITORING_SESSION_STORE;
      try {
        fs.rmSync(path.dirname(storePath), { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
    }
  });

  it('drops expired sessions when loading from disk', () => {
    const storePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'smartcube-sessions-')),
      'sessions.json',
    );
    fs.writeFileSync(
      storePath,
      JSON.stringify([
        { id: 'expired', mgrId: 'admin', expiresAt: Date.now() - 1000 },
        { id: 'live', mgrId: 'admin', expiresAt: Date.now() + 60_000 },
      ]),
    );

    try {
      const service = new MonitoringAuthService(
        createConfig({
          'monitoringAuth.sessionStore': storePath,
        }) as ConfigService,
        { query: jest.fn() } as unknown as DatabaseService,
      );

      expect(
        service.getSessionFromRequest({
          headers: { cookie: 'smartcube_monitoring_session=expired' },
        } as Request),
      ).toBeNull();
      expect(
        service.getSessionFromRequest({
          headers: { cookie: 'smartcube_monitoring_session=live' },
        } as Request),
      ).not.toBeNull();
    } finally {
      try {
        fs.rmSync(path.dirname(storePath), { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
    }
  });

  it('sanitizes next paths to stay within monitoring HTML routes', () => {
    const service = new MonitoringAuthService(
      createConfig() as ConfigService,
      { query: jest.fn() } as unknown as DatabaseService,
    );

    expect(service.sanitizeNextPath('/monitoring')).toBe('/monitoring');
    // search/hash 는 폐기 — Location 헤더 fragment 인코딩 미보장 + login HTML reflect 우려
    expect(service.sanitizeNextPath('/monitoring?tab=logs')).toBe('/monitoring');
    expect(service.sanitizeNextPath('/monitoring#feed')).toBe('/monitoring');
    expect(service.sanitizeNextPath('/monitoring/api/stats')).toBe(
      '/monitoring',
    );
    expect(service.sanitizeNextPath('/monitoringevil')).toBe('/monitoring');
    expect(service.sanitizeNextPath('https://example.com')).toBe('/monitoring');
    // Swagger UI HTML 만 화이트리스트 허용
    expect(service.sanitizeNextPath('/api-docs')).toBe('/api-docs');
    // /api-docs-json 은 redirect 화이트리스트 제외 (raw JSON 페이지 머무름 회피)
    expect(service.sanitizeNextPath('/api-docs-json')).toBe('/monitoring');
    // 화이트리스트에 없는 임의 /api-docs 하위 경로는 거부
    expect(service.sanitizeNextPath('/api-docs/swagger-ui.css')).toBe(
      '/monitoring',
    );
  });
});
