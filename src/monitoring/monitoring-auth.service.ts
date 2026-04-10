import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/database.service';

export interface MonitoringSession {
  id: string;
  mgrId: string;
  expiresAt: number;
}

type CookieSecurePolicy = 'always' | 'never' | 'auto';

@Injectable()
export class MonitoringAuthService {
  private readonly sessions = new Map<string, MonitoringSession>();
  private readonly cookieName: string;
  private readonly sessionTtlMs: number;
  private readonly cookieSecurePolicy: CookieSecurePolicy;
  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
  ) {
    this.cookieName =
      this.config.get<string>('monitoringAuth.cookieName') ??
      'smartcube_monitoring_session';
    const configuredTtl =
      this.config.get<number>('monitoringAuth.sessionTtlMs') ??
      8 * 60 * 60 * 1000;
    this.sessionTtlMs = configuredTtl > 0 ? configuredTtl : 8 * 60 * 60 * 1000;
    this.cookieSecurePolicy = this.normalizeCookieSecurePolicy(
      this.config.get<string>('monitoringAuth.cookieSecure'),
    );
  }

  async validateCredentials(
    mgrId: string,
    mgrPwd: string,
  ): Promise<{ mgrId: string } | null> {
    const trimmedMgrId = mgrId.trim();
    if (!trimmedMgrId || !mgrPwd) {
      return null;
    }

    const result = await this.db.query<{ MgrId: string }>(
      `SELECT TOP 1 MgrId
       FROM tblMgrAccnt
       WHERE MgrId = @mgrId
         AND MgrPwd = @mgrPwd
         AND ISNULL(EnableAccnt, 0) = 1`,
      {
        mgrId: trimmedMgrId,
        mgrPwd,
      },
    );

    const account = result.recordset[0];
    return account ? { mgrId: account.MgrId } : null;
  }

  createSession(mgrId: string): MonitoringSession {
    this.pruneExpiredSessions();
    const session: MonitoringSession = {
      id: randomBytes(32).toString('hex'),
      mgrId,
      expiresAt: Date.now() + this.sessionTtlMs,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSessionFromRequest(req: Request): MonitoringSession | null {
    const sessionId = this.readSessionIdFromRequest(req);
    if (!sessionId) return null;

    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  destroySession(sessionId: string | null | undefined): void {
    if (!sessionId) return;
    this.sessions.delete(sessionId);
  }

  destroySessionFromRequest(req: Request): boolean {
    const sessionId = this.readSessionIdFromRequest(req);
    if (!sessionId) return false;
    this.destroySession(sessionId);
    return true;
  }

  hasSessionCookie(req: Request): boolean {
    return this.readSessionIdFromRequest(req) !== null;
  }

  clearSessionFromRequest(req: Request, res: Response): void {
    this.destroySessionFromRequest(req);
    this.clearSessionCookie(res, req);
  }

  setSessionCookie(res: Response, req: Request, sessionId: string): void {
    res.append(
      'Set-Cookie',
      this.serializeCookie({
        value: sessionId,
        maxAgeSeconds: Math.max(1, Math.floor(this.sessionTtlMs / 1000)),
        req,
      }),
    );
  }

  clearSessionCookie(res: Response, req: Request): void {
    res.append(
      'Set-Cookie',
      this.serializeCookie({ value: '', maxAgeSeconds: 0, req }),
    );
  }

  sanitizeNextPath(next?: string | null): string {
    if (!next) return '/monitoring';
    if (!next.startsWith('/') || next.startsWith('//')) return '/monitoring';

    try {
      const parsed = new URL(next, 'http://monitoring.local');
      if (parsed.pathname !== '/monitoring') {
        return '/monitoring';
      }
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return '/monitoring';
    }
  }

  private readSessionIdFromRequest(req: Request): string | null {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;

    for (const part of cookieHeader.split(';')) {
      const [rawKey, ...rawValue] = part.split('=');
      if (!rawKey || rawValue.length === 0) continue;
      if (rawKey.trim() !== this.cookieName) continue;
      const value = rawValue.join('=').trim();
      return value ? decodeURIComponent(value) : null;
    }
    return null;
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private shouldUseSecureCookie(req: Request): boolean {
    if (this.cookieSecurePolicy === 'always') return true;
    if (this.cookieSecurePolicy === 'never') return false;
    return req.secure;
  }

  private serializeCookie(params: {
    value: string;
    maxAgeSeconds: number;
    req: Request;
  }): string {
    const { value, maxAgeSeconds, req } = params;
    const parts = [
      `${this.cookieName}=${encodeURIComponent(value)}`,
      'Path=/monitoring',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ];

    if (maxAgeSeconds === 0) {
      parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    } else {
      parts.push(
        `Expires=${new Date(Date.now() + maxAgeSeconds * 1000).toUTCString()}`,
      );
    }

    if (this.shouldUseSecureCookie(req)) {
      parts.push('Secure');
    }

    return parts.join('; ');
  }

  private normalizeCookieSecurePolicy(
    policy: string | undefined,
  ): CookieSecurePolicy {
    switch (policy?.toLowerCase()) {
      case 'always':
      case 'true':
        return 'always';
      case 'never':
      case 'false':
        return 'never';
      default:
        return 'auto';
    }
  }
}
