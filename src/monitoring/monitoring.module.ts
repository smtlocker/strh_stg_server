import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { SyncLogService } from './sync-log.service';
import { WebhookLogInterceptor } from './webhook-log.interceptor';
import { MonitoringController } from './monitoring.controller';
import { MonitoringAuthController } from './monitoring-auth.controller';
import { SiteSyncService } from './site-sync.service';
import { UserSyncService } from './user-sync.service';
import { ReplayabilityService } from './replayability.service';
import { ReprocessService } from './reprocess.service';
import { FailureAlertService } from './failure-alert.service';
import { StoreganiseModule } from '../storeganise/storeganise.module';
import { UnitSyncHandler } from '../handlers/unit-sync.handler';
import { MoveInHandler } from '../handlers/move-in.handler';
import { MoveOutHandler } from '../handlers/move-out.handler';
import { OverdueHandler } from '../handlers/overdue.handler';
import { TransferHandler } from '../handlers/transfer.handler';
import { UserHandler } from '../handlers/user.handler';
import { MonitoringAuthService } from './monitoring-auth.service';
import { MonitoringSessionMiddleware } from './monitoring-auth.middleware';
import { MonitoringOriginValidatorService } from './monitoring-origin-validator.service';

@Module({
  imports: [StoreganiseModule],
  controllers: [MonitoringController, MonitoringAuthController],
  providers: [
    SyncLogService,
    WebhookLogInterceptor,
    SiteSyncService,
    UserSyncService,
    ReplayabilityService,
    ReprocessService,
    FailureAlertService,
    UnitSyncHandler,
    MoveInHandler,
    MoveOutHandler,
    OverdueHandler,
    TransferHandler,
    UserHandler,
    MonitoringAuthService,
    MonitoringSessionMiddleware,
    MonitoringOriginValidatorService,
  ],
  exports: [SyncLogService, WebhookLogInterceptor],
})
export class MonitoringModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(MonitoringSessionMiddleware)
      .exclude(
        { path: 'login', method: RequestMethod.GET },
        { path: 'login', method: RequestMethod.POST },
        { path: 'logout', method: RequestMethod.POST },
      )
      .forRoutes(MonitoringController);
    // /api-docs 경로는 SwaggerModule 이 Express 레벨에서 라우트를 등록하므로
    // NestJS MiddlewareConsumer 로는 보호 불가능. main.ts 에서 app.use 로 직접 처리.
  }
}
