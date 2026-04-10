import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { StoreganiseModule } from './storeganise/storeganise.module';
import { WebhookModule } from './webhook/webhook.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { ScheduledJobRepositoryModule } from './scheduler/scheduled-job-repository.module';
import { ApiModule } from './api/api.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    DatabaseModule,
    ScheduledJobRepositoryModule,
    StoreganiseModule,
    WebhookModule,
    MonitoringModule,
    SchedulerModule,
    ApiModule,
  ],
})
export class AppModule {}
