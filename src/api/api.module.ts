import { Module } from '@nestjs/common';
import { AccessCodeController } from './access-code.controller';
import { StoreganiseModule } from '../storeganise/storeganise.module';

@Module({
  imports: [StoreganiseModule],
  controllers: [AccessCodeController],
})
export class ApiModule {}
