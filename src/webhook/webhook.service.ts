import { Injectable, Logger } from '@nestjs/common';
import { WebhookPayloadDto } from './dto/webhook-payload.dto';
import { MoveInHandler } from '../handlers/move-in.handler';
import { MoveOutHandler } from '../handlers/move-out.handler';
import { OverdueHandler } from '../handlers/overdue.handler';
import { RentalUpdatedHandler } from '../handlers/rental-updated.handler';
import { UserHandler } from '../handlers/user.handler';
import { TransferHandler } from '../handlers/transfer.handler';
import { UnitSyncHandler } from '../handlers/unit-sync.handler';
import { DatabaseService } from '../database/database.service';
import { SyncMeta } from '../monitoring/monitoring.types';
import { buildWebhookDedupKey } from '../common/webhook-dedup';

export interface WebhookHandleResult {
  skipLog?: boolean;
  syncMeta?: SyncMeta;
  dedupKey?: string | null;
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  private static readonly DEDUP_WINDOW_SECONDS = 10;

  constructor(
    private readonly db: DatabaseService,
    private readonly moveInHandler: MoveInHandler,
    private readonly moveOutHandler: MoveOutHandler,
    private readonly overdueHandler: OverdueHandler,
    private readonly rentalUpdatedHandler: RentalUpdatedHandler,
    private readonly userHandler: UserHandler,
    private readonly transferHandler: TransferHandler,
    private readonly unitSyncHandler: UnitSyncHandler,
  ) {}

  async handle(payload: WebhookPayloadDto): Promise<WebhookHandleResult> {
    this.logger.log(
      `Routing event: ${payload.type} (id: ${payload.id ?? 'N/A'})`,
    );

    const dedupKey = buildWebhookDedupKey(payload);
    if (dedupKey && (await this.isDuplicate(dedupKey))) {
      this.logger.log(`[dedup] Skipping duplicate webhook: ${dedupKey}`);
      return { skipLog: true };
    }

    try {
      switch (payload.type) {
        case 'job.unit_moveIn.completed':
          this.logger.log(`→ Dispatching to MoveInHandler`);
          return this.withSyncMeta(await this.moveInHandler.handle(payload), dedupKey);

        case 'job.unit_moveOut.created':
        case 'job.unit_moveOut.completed':
        case 'job.unit_moveOut.cancelled':
          this.logger.log(`→ Dispatching to MoveOutHandler`);
          return this.withSyncMeta(await this.moveOutHandler.handle(payload), dedupKey);

        case 'job.unit_transfer.completed':
          this.logger.log(`→ Dispatching to TransferHandler`);
          return this.withSyncMeta(await this.transferHandler.handle(payload), dedupKey);

        case 'unitRental.markOverdue':
        case 'unitRental.unmarkOverdue':
          this.logger.log(`→ Dispatching to OverdueHandler`);
          return this.withSyncMeta(await this.overdueHandler.handle(payload), dedupKey);

        case 'unitRental.updated':
          this.logger.log(`→ Dispatching to RentalUpdatedHandler`);
          return this.withSyncMeta(
            await this.rentalUpdatedHandler.handle(payload), dedupKey,
          );

        case 'user.updated':
          this.logger.log(`→ Dispatching to UserHandler`);
          return this.withSyncMeta(await this.userHandler.handle(payload), dedupKey);

        case 'unit.updated': {
          const unitChangedKeys = payload.data?.changedKeys;
          if (
            !unitChangedKeys ||
            !unitChangedKeys.includes('customFields.smartcube_syncUnit')
          ) {
            this.logger.log(
              `unit.updated: no smartcube_syncUnit change, skipping`,
            );
            return { skipLog: true };
          }
          this.logger.log(`→ Dispatching to UnitSyncHandler`);
          return this.withSyncMeta(await this.unitSyncHandler.handle(payload), dedupKey);
        }

        default:
          this.logger.warn(`⚠ Unhandled event type: ${payload.type}`);
          return {};
      }
    } catch (err) {
      this.logger.error(
        `Error handling ${payload.type}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  private withSyncMeta(
    meta: SyncMeta | void,
    dedupKey?: string | null,
  ): WebhookHandleResult {
    const result: WebhookHandleResult = meta ? { syncMeta: meta } : {};
    if (dedupKey) result.dedupKey = dedupKey;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Webhook dedup — 같은 대상에 대한 10초 이내 중복 이벤트 skip
  // ---------------------------------------------------------------------------

  private async isDuplicate(dedupKey: string): Promise<boolean> {
    const result = await this.db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM tblSyncLog
       WHERE correlationKey = @key
         AND source IN ('webhook', 'scheduler')
         AND status = 'success'
         AND createdAt > DATEADD(second, -@window, GETDATE())`,
      { key: dedupKey, window: WebhookService.DEDUP_WINDOW_SECONDS },
    );
    return (result.recordset[0]?.cnt ?? 0) > 0;
  }
}
