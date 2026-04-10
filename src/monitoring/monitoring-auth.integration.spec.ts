import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'http';
import * as bodyParser from 'body-parser';
import request from 'supertest';
import { DatabaseService } from '../database/database.service';
import { MonitoringAuthController } from './monitoring-auth.controller';
import { MonitoringAuthService } from './monitoring-auth.service';
import { MonitoringController } from './monitoring.controller';
import { MonitoringSessionMiddleware } from './monitoring-auth.middleware';
import { MonitoringOriginValidatorService } from './monitoring-origin-validator.service';
import { ReprocessService } from './reprocess.service';
import { SiteSyncService } from './site-sync.service';
import { SyncLogService } from './sync-log.service';
import { UserSyncService } from './user-sync.service';

describe('Monitoring auth integration', () => {
  let app: INestApplication;
  let httpServer: Server;
  const db = {
    query: jest.fn(),
  };
  const syncLog = {
    events$: { pipe: jest.fn() },
    getStats: jest.fn(() => ({ ok: true })),
    getAll: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    getPendingScheduled: jest.fn().mockResolvedValue([]),
    getErrors: jest.fn().mockResolvedValue([]),
    getGroupsByOffice: jest.fn().mockResolvedValue([]),
    getUnitsByGroup: jest.fn().mockResolvedValue([]),
  };
  const siteSync = {
    getStgUnits: jest.fn().mockResolvedValue({ groups: [] }),
    isRunning: jest.fn().mockReturnValue(false),
    startSync: jest.fn().mockReturnValue('site-job'),
    stopSync: jest.fn().mockReturnValue(true),
    getJobStream: jest.fn().mockReturnValue(null),
  };
  const userSync = {
    isRunning: jest.fn().mockReturnValue(false),
    startSync: jest.fn().mockReturnValue('user-job'),
    stopSync: jest.fn().mockReturnValue(true),
    getJobStream: jest.fn().mockReturnValue(null),
  };
  const reprocess = {
    reprocess: jest.fn().mockResolvedValue({ ok: true }),
  };
  const config = {
    get: jest.fn((key: string) => {
      const values: Record<string, string | number | undefined> = {
        'monitoringAuth.cookieName': 'smartcube_monitoring_session',
        'monitoringAuth.sessionTtlMs': 60_000,
        'monitoringAuth.cookieSecure': 'never',
      };
      return values[key];
    }),
  };

  @Module({
    controllers: [MonitoringController, MonitoringAuthController],
    providers: [
      MonitoringAuthService,
      MonitoringSessionMiddleware,
      MonitoringOriginValidatorService,
      { provide: DatabaseService, useValue: db },
      { provide: ConfigService, useValue: config },
      { provide: SyncLogService, useValue: syncLog },
      { provide: SiteSyncService, useValue: siteSync },
      { provide: UserSyncService, useValue: userSync },
      { provide: ReprocessService, useValue: reprocess },
    ],
  })
  class TestMonitoringModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer
        .apply(MonitoringSessionMiddleware)
        .exclude(
          { path: 'monitoring/login', method: RequestMethod.GET },
          { path: 'monitoring/login', method: RequestMethod.POST },
          { path: 'monitoring/logout', method: RequestMethod.POST },
        )
        .forRoutes(MonitoringController);
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestMonitoringModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: false }));
    await app.init();
    httpServer = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    syncLog.getStats.mockReturnValue({ ok: true });
    syncLog.getAll.mockResolvedValue({ items: [], total: 0 });
    syncLog.getPendingScheduled.mockResolvedValue([]);
    reprocess.reprocess.mockResolvedValue({ ok: true });
  });

  it('redirects logged-out dashboard requests to login and returns 401 for API', async () => {
    await request(httpServer)
      .get('/monitoring')
      .expect(302)
      .expect('Location', '/monitoring/login?next=%2Fmonitoring');

    const apiResponse = await request(httpServer)
      .get('/monitoring/api/stats')
      .expect(401);

    expect(apiResponse.body).toEqual({ error: 'Monitoring login required' });
  });

  it('authenticates, renders current MgrId, preserves POST whitelist behavior, and logs out', async () => {
    db.query.mockResolvedValueOnce({ recordset: [{ MgrId: 'admin' }] });

    const loginResponse = await request(httpServer)
      .post('/monitoring/login')
      .set('Host', 'monitoring.test')
      .set('Origin', 'http://monitoring.test')
      .type('form')
      .send({ mgrId: 'admin', mgrPwd: 'test1234!', next: '/monitoring' })
      .expect(303)
      .expect('Location', '/monitoring');

    const cookie = loginResponse.headers['set-cookie'][0];
    expect(cookie).toContain('smartcube_monitoring_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');

    await request(httpServer)
      .get('/monitoring/api/stats')
      .set('Cookie', cookie)
      .expect(200)
      .expect({ ok: true });

    const dashboardResponse = await request(httpServer)
      .get('/monitoring')
      .set('Cookie', cookie)
      .expect(200);

    expect(dashboardResponse.text).toContain('로그인: admin');

    await request(httpServer)
      .post('/monitoring/api/errors/41/reprocess')
      .set('Cookie', cookie)
      .expect(201);

    expect(reprocess.reprocess).toHaveBeenCalledWith(41);

    const logoutResponse = await request(httpServer)
      .post('/monitoring/logout')
      .set('Cookie', cookie)
      .set('Host', 'monitoring.test')
      .set('Origin', 'http://monitoring.test')
      .expect(303)
      .expect('Location', '/monitoring/login');

    expect(logoutResponse.headers['set-cookie'][0]).toContain('Max-Age=0');

    await request(httpServer)
      .get('/monitoring')
      .set('Cookie', cookie)
      .expect(302)
      .expect('Location', '/monitoring/login?next=%2Fmonitoring');
  });

  it('replaces the previous session on re-login so the old cookie no longer works', async () => {
    db.query
      .mockResolvedValueOnce({ recordset: [{ MgrId: 'admin' }] })
      .mockResolvedValueOnce({ recordset: [{ MgrId: 'admin' }] });

    const firstLogin = await request(httpServer)
      .post('/monitoring/login')
      .set('Host', 'monitoring.test')
      .set('Origin', 'http://monitoring.test')
      .type('form')
      .send({ mgrId: 'admin', mgrPwd: 'test1234!', next: '/monitoring' })
      .expect(303);
    const firstCookie = firstLogin.headers['set-cookie'][0];

    const secondLogin = await request(httpServer)
      .post('/monitoring/login')
      .set('Cookie', firstCookie)
      .set('Host', 'monitoring.test')
      .set('Origin', 'http://monitoring.test')
      .type('form')
      .send({ mgrId: 'admin', mgrPwd: 'test1234!', next: '/monitoring' })
      .expect(303);
    const secondCookie = secondLogin.headers['set-cookie'][0];

    expect(secondCookie).not.toEqual(firstCookie);

    await request(httpServer)
      .get('/monitoring/api/stats')
      .set('Cookie', firstCookie)
      .expect(401);

    await request(httpServer)
      .get('/monitoring/api/stats')
      .set('Cookie', secondCookie)
      .expect(200)
      .expect({ ok: true });
  });

  it('shows a generic error on invalid login', async () => {
    db.query.mockResolvedValueOnce({ recordset: [] });

    const response = await request(httpServer)
      .post('/monitoring/login')
      .set('Host', 'monitoring.test')
      .set('Origin', 'http://monitoring.test')
      .type('form')
      .send({ mgrId: 'admin', mgrPwd: 'wrong' })
      .expect(401);

    expect(response.text).toContain(
      '아이디 또는 비밀번호가 올바르지 않습니다.',
    );
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects cross-site or header-less login attempts with 403 and no auth cookie', async () => {
    const foreignResponse = await request(httpServer)
      .post('/monitoring/login')
      .set('Host', 'monitoring.test')
      .set('Origin', 'http://evil.test')
      .type('form')
      .send({ mgrId: 'admin', mgrPwd: 'test1234!' })
      .expect(403);

    expect(foreignResponse.text).toContain('허용되지 않은 요청입니다.');
    expect(foreignResponse.headers['set-cookie']).toBeUndefined();

    const headerlessResponse = await request(httpServer)
      .post('/monitoring/login')
      .set('Host', 'monitoring.test')
      .type('form')
      .send({ mgrId: 'admin', mgrPwd: 'test1234!' })
      .expect(403);

    expect(headerlessResponse.headers['set-cookie']).toBeUndefined();
  });

  it('rejects cross-site or header-less logout attempts without clearing the session', async () => {
    db.query.mockResolvedValueOnce({ recordset: [{ MgrId: 'admin' }] });
    const loginResponse = await request(httpServer)
      .post('/monitoring/login')
      .set('Host', 'monitoring.test')
      .set('Origin', 'http://monitoring.test')
      .type('form')
      .send({ mgrId: 'admin', mgrPwd: 'test1234!', next: '/monitoring' })
      .expect(303);
    const cookie = loginResponse.headers['set-cookie'][0];

    const foreignLogout = await request(httpServer)
      .post('/monitoring/logout')
      .set('Cookie', cookie)
      .set('Host', 'monitoring.test')
      .set('Origin', 'http://evil.test')
      .expect(403);

    expect(foreignLogout.headers['set-cookie']).toBeUndefined();

    await request(httpServer)
      .get('/monitoring/api/stats')
      .set('Cookie', cookie)
      .expect(200);

    const headerlessLogout = await request(httpServer)
      .post('/monitoring/logout')
      .set('Cookie', cookie)
      .set('Host', 'monitoring.test')
      .expect(403);

    expect(headerlessLogout.headers['set-cookie']).toBeUndefined();

    await request(httpServer)
      .get('/monitoring/api/stats')
      .set('Cookie', cookie)
      .expect(200);
  });
});
