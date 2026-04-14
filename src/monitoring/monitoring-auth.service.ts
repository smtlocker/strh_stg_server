import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';

export interface MonitoringSession {
  id: string;
  mgrId: string;
  expiresAt: number;
}

type CookieSecurePolicy = 'always' | 'never' | 'auto';

@Injectable()
export class MonitoringAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(MonitoringAuthService.name);
  private readonly sessions = new Map<string, MonitoringSession>();
  private readonly cookieName: string;
  private readonly sessionTtlMs: number;
  private readonly cookieSecurePolicy: CookieSecurePolicy;
  // 세션 persistence — pm2 restart 후에도 로그인 유지 목적. null = 비활성.
  private readonly storePath: string | null;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
  ) {
    this.cookieName =
      this.config.get<string>('monitoringAuth.cookieName') ??
      'smartcube_monitoring_session';
    const configuredTtl =
      this.config.get<number>('monitoringAuth.sessionTtlMs') ??
      24 * 60 * 60 * 1000;
    this.sessionTtlMs = configuredTtl > 0 ? configuredTtl : 24 * 60 * 60 * 1000;
    this.cookieSecurePolicy = this.normalizeCookieSecurePolicy(
      this.config.get<string>('monitoringAuth.cookieSecure'),
    );
    this.storePath = this.resolveStorePath();
    this.loadFromDisk();
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
    this.scheduleWrite();
    return session;
  }

  getSessionFromRequest(req: Request): MonitoringSession | null {
    const sessionId = this.readSessionIdFromRequest(req);
    if (!sessionId) return null;

    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      this.scheduleWrite();
      return null;
    }
    // 슬라이딩 세션: 잔여 TTL 이 50% 미만일 때만 갱신/persist —
    // 요청마다 disk 쓰기 (SSE/dashboard polling 으로 분당 수백 회) 회피.
    const now = Date.now();
    const remaining = session.expiresAt - now;
    if (remaining < this.sessionTtlMs / 2) {
      session.expiresAt = now + this.sessionTtlMs;
      this.scheduleWrite();
    }
    return session;
  }

  destroySession(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    const removed = this.sessions.delete(sessionId);
    if (removed) this.scheduleWrite();
    return removed;
  }

  destroySessionFromRequest(req: Request): boolean {
    const sessionId = this.readSessionIdFromRequest(req);
    if (!sessionId) return false;
    return this.destroySession(sessionId);
  }

  hasSessionCookie(req: Request): boolean {
    return this.readSessionIdFromRequest(req) !== null;
  }

  clearSessionFromRequest(req: Request, res: Response): void {
    this.destroySessionFromRequest(req);
    this.clearSessionCookie(res, req);
  }

  setSessionCookie(res: Response, req: Request, sessionId: string): void {
    // 과거 Path=/monitoring 로 발급된 stale cookie 가 브라우저에 남아있을 수
    // 있으므로, 새 cookie set 시 함께 무효화한다. 한 번 정리되면 향후 요청에는
    // Path=/ cookie 만 남는다.
    this.appendStaleMonitoringCookieClear(res);
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
    this.appendStaleMonitoringCookieClear(res);
    res.append(
      'Set-Cookie',
      this.serializeCookie({ value: '', maxAgeSeconds: 0, req }),
    );
  }

  private appendStaleMonitoringCookieClear(res: Response): void {
    res.append(
      'Set-Cookie',
      `${this.cookieName}=; Path=/monitoring; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    );
  }

  sanitizeNextPath(next?: string | null): string {
    if (!next) return '/monitoring';
    if (!next.startsWith('/') || next.startsWith('//')) return '/monitoring';

    // Open-redirect 방지: 화이트리스트 등록 내부 경로만 허용.
    // /monitoring (대시보드), /api-docs (Swagger UI). /api-docs-json 은 redirect
    // 대상에서 제외 — 사용자가 raw spec JSON 페이지에 머무르는 UX 회피.
    const ALLOWED = new Set(['/monitoring', '/api-docs']);

    try {
      const parsed = new URL(next, 'http://monitoring.local');
      if (!ALLOWED.has(parsed.pathname)) {
        return '/monitoring';
      }
      // search/hash 는 폐기 — Express Location 헤더의 fragment 미인코딩으로 인한
      // phishing/XSS hardening (login HTML 의 next 입력 reflect 도 함께 정리).
      return parsed.pathname;
    } catch {
      return '/monitoring';
    }
  }

  private readSessionIdFromRequest(req: Request): string | null {
    // 같은 이름의 cookie 가 다른 path 로 동시에 존재할 수 있다 (예: 과거에
    // Path=/monitoring 으로 발급된 stale cookie 가 현재 Path=/ cookie 와 공존).
    // RFC 6265 상 더 specific 한 path 가 먼저 오므로 첫 번째만 읽으면 stale
    // sessionId 를 잡게 된다. 모든 매칭 cookie 를 순회하며 sessions 에 살아있는
    // 첫 번째 sessionId 를 반환하고, 없으면 마지막으로 본 sessionId 를 반환해
    // 호출자가 stale cookie clear 분기를 그대로 탈 수 있게 한다.
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;

    let lastSeen: string | null = null;
    for (const part of cookieHeader.split(';')) {
      const [rawKey, ...rawValue] = part.split('=');
      if (!rawKey || rawValue.length === 0) continue;
      if (rawKey.trim() !== this.cookieName) continue;
      const value = rawValue.join('=').trim();
      if (!value) continue;
      const sessionId = decodeURIComponent(value);
      if (this.sessions.has(sessionId)) {
        return sessionId;
      }
      lastSeen = sessionId;
    }
    return lastSeen;
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    let pruned = 0;
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
        pruned++;
      }
    }
    if (pruned > 0) this.scheduleWrite();
  }

  private resolveStorePath(): string | null {
    const configured =
      this.config.get<string>('monitoringAuth.sessionStore') ??
      process.env.MONITORING_SESSION_STORE;
    if (configured === 'off' || configured === 'none') return null;
    if (configured) return configured;
    // 테스트 환경에서는 디스크 부수효과 회피 (명시적 store path 만 활성화).
    if (process.env.NODE_ENV === 'test') return null;
    return path.resolve(process.cwd(), '.sessions.json');
  }

  private loadFromDisk(): void {
    if (!this.storePath) return;
    try {
      if (!fs.existsSync(this.storePath)) return;
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const data = JSON.parse(raw) as MonitoringSession[];
      const now = Date.now();
      let loaded = 0;
      for (const s of data) {
        if (
          s &&
          typeof s.id === 'string' &&
          typeof s.mgrId === 'string' &&
          typeof s.expiresAt === 'number' &&
          s.expiresAt > now
        ) {
          this.sessions.set(s.id, s);
          loaded++;
        }
      }
      this.logger.log(
        `Loaded ${loaded} session(s) from ${this.storePath}`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to load sessions from ${this.storePath}: ${(err as Error).message}`,
      );
    }
  }

  private scheduleWrite(): void {
    if (!this.storePath) return;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flushToDisk();
    }, 200);
    this.writeTimer.unref?.();
  }

  /** 테스트 / shutdown 동기 flush 용. pending debounce 가 있으면 즉시 비운다. */
  flushSessionsToDisk(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.flushToDisk();
  }

  /** NestJS shutdown hook — pending write 가 유실되지 않도록 동기 flush. */
  onModuleDestroy(): void {
    this.flushSessionsToDisk();
  }

  private flushToDisk(): void {
    if (!this.storePath) return;
    try {
      // 부모 디렉토리 보장 — 환경별 cwd 가 비어있을 수 있음.
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const now = Date.now();
      const live = Array.from(this.sessions.values()).filter(
        (s) => s.expiresAt > now,
      );
      const tmp = `${this.storePath}.tmp`;
      // mode 0o600 — 다중 사용자 호스트에서 sessionId 노출 방지.
      // POSIX rename 으로 atomic replace (Windows 는 미지원 — pm2 Linux 운영 전제).
      fs.writeFileSync(tmp, JSON.stringify(live), { mode: 0o600 });
      fs.renameSync(tmp, this.storePath);
    } catch (err) {
      this.logger.warn(
        `Failed to write sessions to ${this.storePath}: ${(err as Error).message}`,
      );
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
      // /login (root), /monitoring, /api-docs 등 보호 대상 경로 전반에서
      // 쿠키가 전송되도록 root path 사용. HttpOnly + SameSite=Lax 로 노출 위험 제한.
      'Path=/',
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
