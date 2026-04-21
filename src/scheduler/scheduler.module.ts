import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { WebhookModule } from '../webhook/webhook.module';
import { StoreganiseModule } from '../storeganise/storeganise.module';
import { ScheduledJobRepositoryModule } from './scheduled-job-repository.module';
import { ScheduledJobWorkerService } from './scheduled-job-worker.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MonitoringModule,
    forwardRef(() => WebhookModule),
    StoreganiseModule,
    ScheduledJobRepositoryModule,
  ],
  providers: [ScheduledJobWorkerService],
})
export class SchedulerModule {}
