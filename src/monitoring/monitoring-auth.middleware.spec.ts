import type { NextFunction, Request, Response } from 'express';
import { MonitoringAuthService } from './monitoring-auth.service';
import { MonitoringSessionMiddleware } from './monitoring-auth.middleware';

const createResponse = (): Partial<Response> & {
  status: jest.Mock;
  json: jest.Mock;
  redirect: jest.Mock;
} => {
  const response: Partial<Response> & {
    status: jest.Mock;
    json: jest.Mock;
    redirect: jest.Mock;
  } = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    redirect: jest.fn(),
  };
  return response;
};

describe('MonitoringSessionMiddleware', () => {
  it('passes through authenticated requests', () => {
    const auth = {
      getSessionFromRequest: jest.fn().mockReturnValue({ id: 'sess-1', mgrId: 'admin' }),
      setSessionCookie: jest.fn(),
      clearSessionCookie: jest.fn(),
    } as unknown as MonitoringAuthService;
    const middleware = new MonitoringSessionMiddleware(auth);
    const next = jest.fn() as NextFunction;
    const response = createResponse();

    middleware.use({} as Request, response as Response, next);

    expect(next).toHaveBeenCalled();
    expect(response.redirect).not.toHaveBeenCalled();
  });

  it('redirects unauthenticated dashboard HTML requests to login', () => {
    const clearSessionCookie = jest.fn();
    const hasSessionCookie = jest.fn().mockReturnValue(false);
    const auth = {
      getSessionFromRequest: jest.fn().mockReturnValue(null),
      clearSessionCookie,
      hasSessionCookie,
    } as unknown as MonitoringAuthService;
    const middleware = new MonitoringSessionMiddleware(auth);
    const response = createResponse();

    middleware.use(
      {
        method: 'GET',
        path: '/',
        originalUrl: '/monitoring?tab=logs',
        headers: { accept: 'text/html' },
      } as Request,
      response as Response,
      jest.fn(),
    );

    expect(hasSessionCookie).toHaveBeenCalled();
    expect(clearSessionCookie).not.toHaveBeenCalled();
    expect(response.redirect).toHaveBeenCalledWith(
      '/monitoring/login?next=%2Fmonitoring%3Ftab%3Dlogs',
    );
  });

  it('returns 401 for unauthenticated monitoring API requests', () => {
    const auth = {
      getSessionFromRequest: jest.fn().mockReturnValue(null),
      clearSessionCookie: jest.fn(),
      hasSessionCookie: jest.fn().mockReturnValue(false),
    } as unknown as MonitoringAuthService;
    const middleware = new MonitoringSessionMiddleware(auth);
    const response = createResponse();

    middleware.use(
      {
        method: 'GET',
        path: '/api/stats',
        originalUrl: '/monitoring/api/stats',
        headers: { accept: 'application/json' },
      } as Request,
      response as Response,
      jest.fn(),
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Monitoring login required',
    });
  });

  it('clears a stale cookie before redirecting or returning 401', () => {
    const clearSessionCookie = jest.fn();
    const auth = {
      getSessionFromRequest: jest.fn().mockReturnValue(null),
      clearSessionCookie,
      hasSessionCookie: jest.fn().mockReturnValue(true),
    } as unknown as MonitoringAuthService;
    const middleware = new MonitoringSessionMiddleware(auth);

    middleware.use(
      {
        method: 'GET',
        path: '/api/logs',
        originalUrl: '/monitoring/api/logs',
        headers: {
          accept: 'application/json',
          cookie: 'smartcube_monitoring_session=stale',
        },
      } as Request,
      createResponse() as Response,
      jest.fn(),
    );

    expect(clearSessionCookie).toHaveBeenCalled();
  });
});
