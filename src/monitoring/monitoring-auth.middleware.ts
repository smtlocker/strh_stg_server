import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MonitoringAuthService } from './monitoring-auth.service';

@Injectable()
export class MonitoringSessionMiddleware implements NestMiddleware {
  constructor(private readonly auth: MonitoringAuthService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const session = this.auth.getSessionFromRequest(req);
    if (session) {
      // 슬라이딩 세션: 쿠키 만료도 갱신
      this.auth.setSessionCookie(res, req, session.id);
      next();
      return;
    }

    if (this.auth.hasSessionCookie(req)) {
      this.auth.clearSessionCookie(res, req);
    }

    if (this.isHtmlDashboardRequest(req)) {
      const nextPath = encodeURIComponent(req.originalUrl || '/monitoring');
      res.redirect(`/login?next=${nextPath}`);
      return;
    }

    res.status(401).json({ error: 'Monitoring login required' });
  }

  private isHtmlDashboardRequest(req: Request): boolean {
    if (req.method !== 'GET') return false;
    const path = req.path || req.originalUrl || '';
    if (path.startsWith('/api/') || path.includes('/monitoring/api/')) {
      return false;
    }

    const accept = req.headers.accept;
    const normalizedAccept = Array.isArray(accept)
      ? accept.join(',')
      : (accept ?? '');

    return (
      !normalizedAccept ||
      normalizedAccept.includes('text/html') ||
      normalizedAccept.includes('*/*')
    );
  }
}
