import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiBody,
  ApiResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { MonitoringAuthService } from './monitoring-auth.service';
import { renderMonitoringLoginHtml } from './monitoring-login.html';
import { MonitoringOriginValidatorService } from './monitoring-origin-validator.service';

type LoginBody = {
  mgrId?: string;
  mgrPwd?: string;
  next?: string;
};

@ApiTags('auth')
// Top-level /login, /logout — 운영 대시보드 + Swagger UI 공용. 다른 root-level
// /login 라우트가 추가되면 Nest boot 시 충돌하므로 의도적으로 namespace 좁힘.
@Controller()
export class MonitoringAuthController {
  constructor(
    private readonly monitoringAuth: MonitoringAuthService,
    private readonly originValidator: MonitoringOriginValidatorService,
  ) {}

  @Get('login')
  @ApiOperation({
    summary: '로그인 페이지 (HTML)',
    description:
      '관리자 로그인 폼을 렌더링한다. `next` 쿼리 파라미터로 로그인 후 이동할 경로를 지정할 수 있으며, 화이트리스트(`/monitoring`, `/api-docs`)에 없는 값은 `/monitoring`으로 대체된다. query/hash 는 폐기.',
  })
  @ApiQuery({
    name: 'next',
    required: false,
    description: '로그인 성공 시 redirect 할 내부 경로',
    example: '/api-docs',
  })
  @ApiResponse({ status: 200, description: '로그인 페이지 HTML' })
  getLogin(
    @Query('next') next: string | undefined,
    @Res() res: Response,
  ): void {
    this.renderLoginPage(res, this.monitoringAuth.sanitizeNextPath(next));
  }

  @Post('login')
  @ApiOperation({
    summary: '로그인 처리',
    description:
      '`mgrId`/`mgrPwd` 검증 → 성공 시 세션 쿠키 발급(`HttpOnly`, `SameSite=Lax`, `Path=/`) + `next`로 303 redirect. 실패는 401(자격 오류), 403(Origin 불일치), 모두 같은 페이지에 에러 표시.',
  })
  @ApiBody({
    description: 'application/x-www-form-urlencoded form body',
    schema: {
      type: 'object',
      properties: {
        mgrId: { type: 'string', description: '관리자 ID' },
        mgrPwd: { type: 'string', description: '관리자 비밀번호' },
        next: {
          type: 'string',
          description: '로그인 후 redirect 경로 (화이트리스트만 허용)',
          example: '/api-docs',
        },
      },
      required: ['mgrId', 'mgrPwd'],
    },
  })
  @ApiResponse({ status: 303, description: '성공 — `next` 경로로 redirect' })
  @ApiResponse({ status: 401, description: '자격 증명 오류' })
  @ApiResponse({ status: 403, description: 'Origin 불일치 (CSRF 가드)' })
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
  @ApiOperation({
    summary: '로그아웃',
    description:
      '서버 메모리의 세션을 무효화하고 세션 쿠키를 비운 뒤 `/login` 으로 redirect 한다. Origin 불일치 시 403.',
  })
  @ApiResponse({ status: 303, description: '로그아웃 후 `/login` 으로 redirect' })
  @ApiResponse({ status: 403, description: 'Origin 불일치 (CSRF 가드)' })
  logout(@Req() req: Request, @Res() res: Response): void {
    if (!this.originValidator.isSameOrigin(req)) {
      this.setNoCacheHeaders(res.status(403));
      res.type('text/plain').send('Forbidden');
      return;
    }

    this.setNoCacheHeaders(res);
    this.monitoringAuth.clearSessionFromRequest(req, res);
    res.redirect(303, '/login');
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
