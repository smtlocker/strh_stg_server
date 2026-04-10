import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { MonitoringAuthService } from './monitoring-auth.service';
import { renderMonitoringLoginHtml } from './monitoring-login.html';
import { MonitoringOriginValidatorService } from './monitoring-origin-validator.service';

type LoginBody = {
  mgrId?: string;
  mgrPwd?: string;
  next?: string;
};

@Controller('monitoring')
export class MonitoringAuthController {
  constructor(
    private readonly monitoringAuth: MonitoringAuthService,
    private readonly originValidator: MonitoringOriginValidatorService,
  ) {}

  @Get('login')
  getLogin(
    @Query('next') next: string | undefined,
    @Res() res: Response,
  ): void {
    this.renderLoginPage(res, this.monitoringAuth.sanitizeNextPath(next));
  }

  @Post('login')
  async login(
    @Body() body: LoginBody,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const mgrId = body.mgrId?.trim() ?? '';
    const mgrPwd = body.mgrPwd ?? '';
    const nextPath = this.monitoringAuth.sanitizeNextPath(body.next);

    if (!this.originValidator.isSameOrigin(req)) {
      this.renderLoginPage(
        res.status(403),
        nextPath,
        '허용되지 않은 요청입니다.',
      );
      return;
    }

    const account = await this.monitoringAuth.validateCredentials(
      mgrId,
      mgrPwd,
    );
    if (!account) {
      this.renderLoginPage(
        res.status(401),
        nextPath,
        '아이디 또는 비밀번호가 올바르지 않습니다.',
      );
      return;
    }

    this.setNoCacheHeaders(res);
    this.monitoringAuth.destroySessionFromRequest(req);
    const session = this.monitoringAuth.createSession(account.mgrId);
    this.monitoringAuth.setSessionCookie(res, req, session.id);
    res.redirect(303, nextPath);
  }

  @Post('logout')
  logout(@Req() req: Request, @Res() res: Response): void {
    if (!this.originValidator.isSameOrigin(req)) {
      this.setNoCacheHeaders(res.status(403));
      res.type('text/plain').send('Forbidden');
      return;
    }

    this.setNoCacheHeaders(res);
    this.monitoringAuth.clearSessionFromRequest(req, res);
    res.redirect(303, '/monitoring/login');
  }

  private renderLoginPage(res: Response, next: string, error?: string): void {
    this.setNoCacheHeaders(res);
    res.type('html').send(
      renderMonitoringLoginHtml({
        error,
        next,
      }),
    );
  }

  private setNoCacheHeaders(res: Response): void {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}
