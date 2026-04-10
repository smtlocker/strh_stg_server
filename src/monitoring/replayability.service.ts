import { Injectable } from '@nestjs/common';
import { SyncLogEntry } from './monitoring.types';

export interface ReplayabilityResult {
  replayable: boolean;
  replayReason: string | null;
}

@Injectable()
export class ReplayabilityService {
  private static readonly REPLAYABLE_WEBHOOK_EVENTS = new Set([
    'job.unit_moveIn.completed',
    'job.unit_moveOut.created',
    'job.unit_moveOut.completed',
    'job.unit_moveOut.cancelled',
    'job.unit_transfer.completed',
    'unitRental.markOverdue',
    'unitRental.unmarkOverdue',
    'user.updated',
  ]);

  evaluate(
    entry: Partial<SyncLogEntry> | null | undefined,
  ): ReplayabilityResult {
    if (!entry) {
      return { replayable: false, replayReason: '로그가 없습니다.' };
    }

    if (entry.status !== 'error') {
      return {
        replayable: false,
        replayReason: '실패 로그만 재처리할 수 있습니다.',
      };
    }

    if (entry.source === 'scheduler') {
      // scheduler 실패는 payload.jobId를 통해 tblScheduledJob을 pending으로 되돌리는 방식으로 재처리
      const payload = this.parsePayload(entry.payload);
      const jobId = payload?.jobId;
      if (typeof jobId !== 'number' || !Number.isFinite(jobId)) {
        return {
          replayable: false,
          replayReason: 'scheduler 로그에 jobId가 없어 재처리가 불가능합니다.',
        };
      }
      return { replayable: true, replayReason: null };
    }

    if (entry.source === 'site-sync') {
      const payload = this.parsePayload(entry.payload);
      const unitId =
        (payload?.unitId as string | undefined) ||
        (payload?.stgUnitId as string | undefined) ||
        entry.stgUnitId ||
        null;
      if (!unitId) {
        return {
          replayable: false,
          replayReason: 'unitId 메타가 없어 site-sync 재처리가 불가능합니다.',
        };
      }
      return { replayable: true, replayReason: null };
    }

    const payload = this.parsePayload(entry.payload);
    if (!payload) {
      return {
        replayable: false,
        replayReason: '원본 payload가 없어 재처리할 수 없습니다.',
      };
    }

    const type = this.getString(payload.type) ?? entry.eventType ?? '';
    if (!type || !ReplayabilityService.REPLAYABLE_WEBHOOK_EVENTS.has(type)) {
      if (type === 'unit.updated') {
        return this.evaluateUnitUpdated(payload);
      }
      if (type === 'unitRental.updated') {
        return this.evaluateUnitRentalUpdated(payload);
      }
      return {
        replayable: false,
        replayReason: '현재 이 이벤트 타입은 수동 재처리를 지원하지 않습니다.',
      };
    }

    return { replayable: true, replayReason: null };
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
    if (typeof payload === 'object') return payload as Record<string, unknown>;
    return null;
  }

  private evaluateUnitUpdated(
    payload: Record<string, unknown>,
  ): ReplayabilityResult {
    const data = this.getPayloadData(payload);
    const changedKeys = this.getChangedKeys(data);
    const unitId = this.getString(data?.unitId);
    if (!unitId) {
      return {
        replayable: false,
        replayReason: 'unitId가 없어 unit.updated 재처리가 불가능합니다.',
      };
    }
    if (!changedKeys.includes('customFields.smartcube_syncUnit')) {
      return {
        replayable: false,
        replayReason:
          '현재 unit.updated는 smartcube_syncUnit 재동기화만 수동 재처리를 지원합니다.',
      };
    }
    return { replayable: true, replayReason: null };
  }

  private evaluateUnitRentalUpdated(
    _payload: Record<string, unknown>,
  ): ReplayabilityResult {
    return {
      replayable: false,
      replayReason: '현재 unitRental.updated 재처리는 지원하지 않습니다.',
    };
  }

  private getPayloadData(
    payload: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const data = payload.data;
    if (!data || typeof data !== 'object') return null;
    return data as Record<string, unknown>;
  }

  private getChangedKeys(data: Record<string, unknown> | null): string[] {
    const raw = data?.changedKeys;
    return Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string')
      : [];
  }

  private getString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }
}
