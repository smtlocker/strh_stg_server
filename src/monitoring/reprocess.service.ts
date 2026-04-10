import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { WebhookPayloadDto } from '../webhook/dto/webhook-payload.dto';
import { SyncLogService } from './sync-log.service';
import { ReplayabilityService } from './replayability.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { MoveInHandler } from '../handlers/move-in.handler';
import { MoveOutHandler } from '../handlers/move-out.handler';
import { OverdueHandler } from '../handlers/overdue.handler';
import { TransferHandler } from '../handlers/transfer.handler';
import { UserHandler } from '../handlers/user.handler';
import { UnitSyncHandler } from '../handlers/unit-sync.handler';
import { ScheduledJobRepository } from '../scheduler/scheduled-job.repository';
import { SyncLogEntry } from './monitoring.types';

@Injectable()
export class ReprocessService {
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly syncLog: SyncLogService,
    private readonly replayability: ReplayabilityService,
    private readonly sgApi: StoreganiseApiService,
    private readonly moveInHandler: MoveInHandler,
    private readonly moveOutHandler: MoveOutHandler,
    private readonly overdueHandler: OverdueHandler,
    private readonly transferHandler: TransferHandler,
    private readonly userHandler: UserHandler,
    private readonly unitSyncHandler: UnitSyncHandler,
    private readonly scheduledJobRepo: ScheduledJobRepository,
  ) {}

  async reprocess(
    id: number,
  ): Promise<{ replayed: true; replayLogId?: number }> {
    if (this.inFlight.has(id)) {
      throw new ConflictException('이미 재처리 중인 로그입니다.');
    }
    this.inFlight.add(id);

    try {
      const entry = await this.syncLog.getById(id);
      if (!entry) throw new NotFoundException('로그를 찾을 수 없습니다.');

      const replay = this.replayability.evaluate(entry);
      if (!replay.replayable) {
        throw new BadRequestException(
          replay.replayReason ?? '재처리할 수 없는 로그입니다.',
        );
      }

      if (entry.source === 'site-sync') {
        return this.reprocessSiteSync(entry);
      }

      if (entry.source === 'webhook') {
        return this.reprocessWebhook(entry);
      }

      if (entry.source === 'scheduler') {
        return this.reprocessScheduler(entry);
      }

      throw new BadRequestException(
        '현재 이 소스는 수동 재처리를 지원하지 않습니다.',
      );
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * scheduler 실패 재처리: tblScheduledJob 행을 pending으로 되돌려
   * 다음 worker tick이 다시 집어가도록 한다.
   * 실제 실행은 worker가 담당하므로 여기서는 requeue만 수행하고
   * 감사용 syncLog에 'replay requested' 성공 로그를 남긴다.
   */
  private async reprocessScheduler(
    entry: SyncLogEntry,
  ): Promise<{ replayed: true; replayLogId?: number }> {
    const payload = this.parsePayload(entry.payload);
    const jobId = payload?.jobId;
    if (typeof jobId !== 'number' || !Number.isFinite(jobId)) {
      throw new BadRequestException(
        'scheduler 로그에 jobId가 없어 재처리할 수 없습니다.',
      );
    }

    const existing = await this.scheduledJobRepo.findById(jobId);
    if (!existing) {
      throw new NotFoundException(
        `scheduled job #${jobId}를 찾을 수 없습니다.`,
      );
    }

    await this.scheduledJobRepo.requeue(jobId);

    const replayEntry = await this.writeReplayLog({
      source: 'scheduler',
      eventType: entry.eventType,
      eventId: entry.eventId ?? null,
      businessCode: entry.businessCode ?? null,
      areaCode: entry.areaCode ?? null,
      showBoxNo: entry.showBoxNo ?? null,
      userName: entry.userName ?? null,
      stgUserId: entry.stgUserId ?? null,
      stgUnitId: entry.stgUnitId ?? null,
      replayedFromLogId: entry.id,
      status: 'success',
      durationMs: 0,
      error: null,
      payload: { jobId, requeued: true },
    });

    return { replayed: true, replayLogId: replayEntry.id };
  }

  private async reprocessWebhook(
    entry: SyncLogEntry,
  ): Promise<{ replayed: true; replayLogId?: number }> {
    const payload = this.parsePayload(
      entry.payload,
    ) as WebhookPayloadDto | null;
    if (!payload) {
      throw new BadRequestException(
        '원본 payload가 없어 재처리할 수 없습니다.',
      );
    }

    const started = Date.now();
    let meta;
    try {
      meta = await this.dispatchWebhookPayload(payload);
    } catch (err) {
      const replayEntry = await this.writeReplayErrorLog({
        source: 'webhook',
        eventType: payload.type,
        eventId: payload.id ?? null,
        businessCode: payload.businessCode ?? null,
        areaCode: entry.areaCode ?? null,
        showBoxNo: entry.showBoxNo ?? null,
        userName: entry.userName ?? null,
        stgUserId: entry.stgUserId ?? null,
        stgUnitId: entry.stgUnitId ?? null,
        replayedFromLogId: entry.id,
        status: 'error',
        durationMs: Date.now() - started,
        error: (err as Error).message,
        payload,
      });
      throw new BadRequestException(
        `재처리 실패: ${(err as Error).message} (replayLogId=${replayEntry?.id ?? 'N/A'})`,
      );
    }

    const replayEntry = await this.writeReplayLog({
      source: 'webhook',
      eventType: payload.type,
      eventId: payload.id ?? null,
      businessCode: payload.businessCode ?? null,
      areaCode: meta?.areaCode ?? entry.areaCode ?? null,
      showBoxNo: meta?.showBoxNo ?? entry.showBoxNo ?? null,
      userName: meta?.userName ?? entry.userName ?? null,
      stgUserId: meta?.stgUserId ?? entry.stgUserId ?? null,
      stgUnitId: meta?.stgUnitId ?? entry.stgUnitId ?? null,
      replayedFromLogId: entry.id,
      status: 'success',
      durationMs: Date.now() - started,
      error: null,
      payload,
    });

    return { replayed: true, replayLogId: replayEntry.id };
  }

  private async reprocessSiteSync(
    entry: SyncLogEntry,
  ): Promise<{ replayed: true; replayLogId?: number }> {
    const payload = this.parsePayload(entry.payload);
    const unitId = (payload?.unitId as string) || entry.stgUnitId;
    if (!unitId) {
      throw new BadRequestException(
        'unitId 메타가 없어 site-sync 재처리가 불가능합니다.',
      );
    }

    const unit = await this.sgApi.getUnit(unitId);
    const started = Date.now();
    let meta;
    try {
      meta = await this.unitSyncHandler.syncUnitWithRetry(unit);
    } catch (err) {
      const replayEntry = await this.writeReplayErrorLog({
        source: 'site-sync',
        eventType: entry.eventType ?? 'unit.synced',
        eventId: entry.eventId ?? null,
        businessCode: entry.businessCode ?? null,
        areaCode: entry.areaCode ?? null,
        showBoxNo: entry.showBoxNo ?? null,
        userName: entry.userName ?? null,
        stgUserId: entry.stgUserId ?? null,
        stgUnitId: unitId,
        replayedFromLogId: entry.id,
        status: 'error',
        durationMs: Date.now() - started,
        error: (err as Error).message,
        payload: payload ?? { unitId },
      });
      throw new BadRequestException(
        `재처리 실패: ${(err as Error).message} (replayLogId=${replayEntry?.id ?? 'N/A'})`,
      );
    }

    const replayEntry = await this.writeReplayLog({
      source: 'site-sync',
      eventType: entry.eventType ?? 'unit.synced',
      eventId: entry.eventId ?? null,
      businessCode: entry.businessCode ?? null,
      areaCode: meta?.areaCode ?? null,
      showBoxNo: meta?.showBoxNo ?? null,
      userName: meta?.userName ?? null,
      stgUserId: meta?.stgUserId ?? null,
      stgUnitId: meta?.stgUnitId ?? unitId,
      replayedFromLogId: entry.id,
      status: 'success',
      durationMs: Date.now() - started,
      error: null,
      payload: payload ?? { unitId },
    });

    return { replayed: true, replayLogId: replayEntry.id };
  }

  private async dispatchWebhookPayload(payload: WebhookPayloadDto) {
    switch (payload.type) {
      case 'job.unit_moveIn.completed':
        return this.moveInHandler.handle(payload);
      case 'job.unit_moveOut.created':
      case 'job.unit_moveOut.completed':
      case 'job.unit_moveOut.cancelled':
        return this.moveOutHandler.handle(payload);
      case 'job.unit_transfer.completed':
        return this.transferHandler.handle(payload);
      case 'unitRental.markOverdue':
      case 'unitRental.unmarkOverdue':
        return this.overdueHandler.handle(payload);
      case 'user.updated':
        return this.userHandler.handle(payload);
      case 'unit.updated':
        return this.reprocessUnitUpdatedPayload(payload);
      default:
        throw new BadRequestException(
          `현재 이 이벤트 타입은 재처리를 지원하지 않습니다: ${payload.type}`,
        );
    }
  }

  private async reprocessUnitUpdatedPayload(payload: WebhookPayloadDto) {
    const unitId = this.getPayloadString(payload.data?.unitId);
    if (!unitId) {
      throw new BadRequestException(
        'unitId가 없어 unit.updated 재처리가 불가능합니다.',
      );
    }

    const unit = await this.sgApi.getUnit(unitId);
    const result = await this.unitSyncHandler.syncUnitWithRetry(unit);
    await this.sgApi.updateUnit(unitId, {
      customFields: { smartcube_syncUnit: false },
    });
    return result;
  }

  private async writeReplayLog(
    entry: Omit<SyncLogEntry, 'id' | 'createdAt'>,
  ): Promise<SyncLogEntry> {
    try {
      const replayEntry = await this.syncLog.add(entry, {
        suppressAlert: true,
        throwOnError: true,
      });
      if (!replayEntry?.id) {
        throw new Error('재처리 로그 기록에 실패했습니다.');
      }
      return replayEntry;
    } catch (err) {
      throw new ConflictException(
        `재처리 감사 로그 기록에 실패했습니다: ${(err as Error).message}`,
      );
    }
  }

  private async writeReplayErrorLog(
    entry: Omit<SyncLogEntry, 'id' | 'createdAt'>,
  ): Promise<SyncLogEntry | undefined> {
    try {
      return await this.writeReplayLog(entry);
    } catch {
      return undefined;
    }
  }

  private parsePayload(payload: unknown): Record<string, unknown> | null {
    if (!payload) return null;
    if (typeof payload === 'string') {
      try {
        return JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return payload as Record<string, unknown>;
  }

  private getPayloadString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }
}
