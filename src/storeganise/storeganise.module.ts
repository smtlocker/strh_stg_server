import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StoreganiseApiService } from './storeganise-api.service';

@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        baseURL: configService.get<string>('storeganise.baseUrl'),
        headers: {
          Authorization: `ApiKey ${configService.get<string>('storeganise.apiKey')}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }),
    }),
  ],
  providers: [StoreganiseApiService],
  exports: [StoreganiseApiService],
})
export class StoreganiseModule {}
