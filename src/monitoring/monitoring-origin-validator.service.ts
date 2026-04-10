import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class MonitoringOriginValidatorService {
  isSameOrigin(req: Request): boolean {
    const host = req.headers.host?.trim();
    if (!host) return false;

    const origin = this.headerValue(req, 'origin');
    if (origin) {
      return this.matchesHost(origin, host);
    }

    const referer = this.headerValue(req, 'referer');
    if (referer) {
      return this.matchesHost(referer, host);
    }

    return false;
  }

  private matchesHost(rawUrl: string, expectedHost: string): boolean {
    try {
      return new URL(rawUrl).host === expectedHost;
    } catch {
      return false;
    }
  }

  private headerValue(req: Request, name: string): string | null {
    const value = req.headers[name];
    if (Array.isArray(value)) {
      return value[0]?.trim() || null;
    }
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
