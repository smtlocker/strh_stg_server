import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import * as bodyParser from 'body-parser';
import { AppModule } from './app.module';
import { version as PKG_VERSION } from '../package.json';
import { MonitoringSessionMiddleware } from './monitoring/monitoring-auth.middleware';
import { stripFallbackTags } from './monitoring/swagger-tag-utils';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });

  app.use(
    bodyParser.json({
      verify: (req: Request, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(bodyParser.urlencoded({ extended: false }));

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // SIGTERM/SIGINT 시 OnModuleDestroy 호출 — MonitoringAuthService 의 pending
  // 세션 flush, scheduled job worker cleanup 등이 정상 동작하도록.
  app.enableShutdownHooks();

  // Swagger 설정 — 운영자 대시보드 + STG webhook 명세 + 통합매니저 access-code.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('SmartCube Sync Server')
    .setVersion(PKG_VERSION)
    .setDescription(
      'STG(Storeganise) ↔ 호호락 동기화 서버 관리 API. 운영자/대시보드용 + STG webhook 수신 + 통합매니저 access-code 변경.',
    )
    .addCookieAuth(
      process.env.MONITORING_SESSION_COOKIE_NAME ??
        'smartcube_monitoring_session',
      { type: 'apiKey', in: 'cookie' },
      'monitoring-session',
    )
    .build();
  const document = stripFallbackTags(
    SwaggerModule.createDocument(app, swaggerConfig),
    ['Monitoring'],
  );

  // SwaggerModule.setup 은 Express 레벨에서 라우트를 등록하므로 NestJS
  // MiddlewareConsumer 로는 보호할 수 없다. 대신 setup 이전에 app.use 로
  // MonitoringSessionMiddleware 를 직접 걸어 대시보드와 동일한 세션 보호를 적용한다.
  // app.use 의 path 인자는 prefix 매칭이라 /api-docs/swagger-ui-bundle.js 등
  // 정적 asset 까지 미들웨어를 통과해 미인증 시 stale-cookie clear 헤더가
  // 반복 발급되므로, 정확한 경로(`/api-docs`, `/api-docs/`, `/api-docs-json`)
  // 일 때만 세션 검사하고 sub-asset 은 통과시킨다 (UI 정적 자원은 정보 유출 없음).
  const sessionMiddleware = app.get(MonitoringSessionMiddleware);
  const protectedSwaggerPaths = new Set([
    '/api-docs',
    '/api-docs/',
    '/api-docs-json',
  ]);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (protectedSwaggerPaths.has(req.path)) {
      return sessionMiddleware.use(req, res, next);
    }
    return next();
  });

  SwaggerModule.setup('api-docs', app, document, {
    customSiteTitle: 'SmartCube API',
    customCss: `
      .swagger-ui .topbar { background-color: #1f2937; padding: 8px 24px; }
      .swagger-ui .topbar .topbar-wrapper { display: flex; align-items: center; gap: 16px; }
      .swagger-ui .topbar .topbar-wrapper .link { display: none; }
      #smartcube-topbar-actions { display: flex; align-items: center; gap: 12px; margin-left: auto; }
      #smartcube-topbar-actions a, #smartcube-topbar-actions button {
        font: 600 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #f9fafb; background: transparent;
        border: 1px solid #f9fafb; border-radius: 6px;
        padding: 6px 12px; cursor: pointer; text-decoration: none;
      }
      #smartcube-topbar-actions a:hover, #smartcube-topbar-actions button:hover {
        background: #f9fafb; color: #1f2937;
      }
      #smartcube-topbar-title { color: #f9fafb; font: 700 16px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    `,
    customJsStr: `
      (function () {
        function injectActions() {
          var topbar = document.querySelector('.swagger-ui .topbar .topbar-wrapper');
          if (!topbar || document.getElementById('smartcube-topbar-actions')) return;

          var title = document.createElement('span');
          title.id = 'smartcube-topbar-title';
          title.textContent = 'SmartCube API';
          topbar.appendChild(title);

          var actions = document.createElement('div');
          actions.id = 'smartcube-topbar-actions';

          var monitoringLink = document.createElement('a');
          monitoringLink.id = 'smartcube-monitoring-link';
          monitoringLink.href = '/monitoring';
          monitoringLink.textContent = '← 모니터링';
          actions.appendChild(monitoringLink);

          var logoutBtn = document.createElement('button');
          logoutBtn.id = 'smartcube-logout-btn';
          logoutBtn.type = 'button';
          logoutBtn.textContent = '로그아웃';
          logoutBtn.addEventListener('click', function () {
            var form = document.createElement('form');
            form.method = 'POST';
            form.action = '/logout';
            document.body.appendChild(form);
            form.submit();
          });
          actions.appendChild(logoutBtn);

          topbar.appendChild(actions);
        }

        var attempts = 0;
        var MAX_ATTEMPTS = 100; // 100 * 100ms = 10s, slow CDN/네트워크 여유
        var timer = setInterval(function () {
          attempts++;
          injectActions();
          if (document.getElementById('smartcube-topbar-actions')) {
            clearInterval(timer);
          } else if (attempts > MAX_ATTEMPTS) {
            clearInterval(timer);
            console.warn('[smartcube] swagger topbar 주입 실패 — 모니터링 링크/로그아웃 버튼 미렌더링');
          }
        }, 100);
      })();
    `,
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') ?? 3000;

  await app.listen(port);
  Logger.log(`Sync server running on port ${port}`, 'Bootstrap');
  Logger.log(`Swagger UI available at /api-docs`, 'Bootstrap');
}
void bootstrap();
