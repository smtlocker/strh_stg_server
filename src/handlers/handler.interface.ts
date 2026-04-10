import { WebhookPayloadDto } from '../webhook/dto/webhook-payload.dto';
import { SyncMeta } from '../monitoring/monitoring.types';

export interface WebhookHandler {
  handle(payload: WebhookPayloadDto): Promise<SyncMeta | void>;
}
