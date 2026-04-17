import { Module } from '@nestjs/common';
import { AccessCodeController } from './access-code.controller';
import { StoreganiseModule } from '../storeganise/storeganise.module';
import { MonitoringModule } from '../monitoring/monitoring.module';

@Module({
  imports: [StoreganiseModule, MonitoringModule],
  controllers: [AccessCodeController],
})
export class ApiModule {}
