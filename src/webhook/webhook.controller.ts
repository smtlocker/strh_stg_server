import {
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
  HttpCode,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { WebhookPayloadDto } from './dto/webhook-payload.dto';
import { WebhookSignatureGuard } from './guards/webhook-signature.guard';
import { WebhookHandleResult, WebhookService } from './webhook.service';
import { WebhookLogInterceptor } from '../monitoring/webhook-log.interceptor';

type WebhookRequest = Request & {
  omxWebhookLog?: WebhookHandleResult;
};

@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly webhookService: WebhookService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(WebhookSignatureGuard)
  @UseInterceptors(WebhookLogInterceptor)
  async handleWebhook(
    @Body() payload: WebhookPayloadDto,
    @Req() req: WebhookRequest,
  ): Promise<{ status: string }> {
    this.logger.log('=== WEBHOOK RECEIVED ===');
    this.logger.log(`Type: ${payload.type}`);
    this.logger.log(`ID: ${payload.id ?? 'N/A'}`);
    this.logger.log(`BusinessCode: ${payload.businessCode ?? 'N/A'}`);
    this.logger.log(`Data: ${JSON.stringify(payload.data, null, 2)}`);
    this.logger.debug(`Full payload: ${JSON.stringify(payload, null, 2)}`);

    const result = await this.webhookService.handle(payload);
    if (result.skipLog || result.syncMeta) {
      req.omxWebhookLog = result;
    }
    return { status: 'ok' };
  }
}
