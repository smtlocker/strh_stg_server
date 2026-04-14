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
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiHeader,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { WebhookPayloadDto } from './dto/webhook-payload.dto';
import { WebhookSignatureGuard } from './guards/webhook-signature.guard';
import { WebhookHandleResult, WebhookService } from './webhook.service';
import { WebhookLogInterceptor } from '../monitoring/webhook-log.interceptor';

type WebhookRequest = Request & {
  omxWebhookLog?: WebhookHandleResult;
};

@ApiTags('webhook')
@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly webhookService: WebhookService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(WebhookSignatureGuard)
  @UseInterceptors(WebhookLogInterceptor)
  @ApiOperation({
    summary: 'STG webhook 수신 — sync server 의 핵심 진입점',
    description:
      'Storeganise 서버가 발생시키는 이벤트를 수신해 호호락 DB 와 동기화한다. ' +
      'HMAC-SHA256 서명(`sg-signature` 헤더, secret = `STG_WEBHOOK_SECRET`) 으로 인증되며 서명 불일치 시 401. ' +
      '\n\n**지원하는 `type` 분기:**\n' +
      '- `job.unit_moveIn.completed` — 입주 완료 → tblBoxMaster 사용자/시작일 갱신\n' +
      '- `job.unit_moveOut.created` / `.completed` / `.cancelled` — 퇴거 라이프사이클 → 스케줄 작업 생성/즉시 처리/취소\n' +
      '- `job.unit_transfer.completed` — 유닛 이전 → 양쪽 유닛 상태 swap\n' +
      '- `unitRental.markOverdue` / `.unmarkOverdue` — 연체 플래그 동기화\n' +
      '- `unitRental.updated` — gate_code/메타데이터 변경 시 PTI/Box 동기화\n' +
      '- `user.updated` — 사용자 정보 갱신 (phone/name/email)\n' +
      '- `unit.updated` — 유닛 마스터 갱신 (이름/그룹 변경)\n' +
      '\n매핑되지 않은 type 은 200 OK 로 반환되되 syncLog 에 `unhandled` 로 기록된다. ' +
      '운영자 수동 호출 대상 아님 — `sg-signature` 없이는 401 로 거부된다.',
  })
  @ApiHeader({
    name: 'sg-signature',
    description: 'STG 가 secret 으로 서명한 HMAC-SHA256 (raw body 기준)',
    required: true,
  })
  @ApiBody({ type: WebhookPayloadDto })
  @ApiResponse({
    status: 200,
    description: '`{ status: "ok" }` — 처리 완료 또는 unhandled type',
  })
  @ApiResponse({ status: 401, description: 'sg-signature 누락/불일치' })
  @ApiResponse({ status: 500, description: '핸들러 내부 오류 (DB/STG API 실패 등)' })
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
