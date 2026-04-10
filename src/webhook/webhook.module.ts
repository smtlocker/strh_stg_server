import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookSignatureGuard } from './guards/webhook-signature.guard';
import { MoveInHandler } from '../handlers/move-in.handler';
import { MoveOutHandler } from '../handlers/move-out.handler';
import { OverdueHandler } from '../handlers/overdue.handler';
import { RentalUpdatedHandler } from '../handlers/rental-updated.handler';
import { UserHandler } from '../handlers/user.handler';
import { TransferHandler } from '../handlers/transfer.handler';
import { UnitSyncHandler } from '../handlers/unit-sync.handler';
import { StoreganiseModule } from '../storeganise/storeganise.module';
import { MonitoringModule } from '../monitoring/monitoring.module';

@Module({
  imports: [StoreganiseModule, MonitoringModule],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhookSignatureGuard,
    MoveInHandler,
    MoveOutHandler,
    OverdueHandler,
    RentalUpdatedHandler,
    UserHandler,
    TransferHandler,
    UnitSyncHandler,
  ],
  exports: [WebhookService],
})
export class WebhookModule {}
