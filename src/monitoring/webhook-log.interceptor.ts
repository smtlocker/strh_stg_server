import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { SyncLogService } from './sync-log.service';
import { SyncMeta } from './monitoring.types';
import { WebhookPayloadDto } from '../webhook/dto/webhook-payload.dto';
import { WebhookHandleResult } from '../webhook/webhook.service';
import { runWithSyncLogContext } from '../common/sync-log-context';
import { ScheduledJobRepository } from '../scheduler/scheduled-job.repository';
import { ScheduledJobEventType } from '../scheduler/scheduled-job.types';
import { buildWebhookDedupKey } from '../common/webhook-dedup';

type LoggedWebhookBody = Partial<WebhookPayloadDto> & Record<string, unknown>;
type LoggedWebhookRequest = Request & {
  body?: LoggedWebhookBody;
  omxWebhookLog?: WebhookHandleResult;
};

@Injectable()
export class WebhookLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(WebhookLogInterceptor.name);

  constructor(
    private readonly syncLog: SyncLogService,
    private readonly scheduledJobRepo: ScheduledJobRepository,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<LoggedWebhookRequest>();
    const body = this.getBody(request.body);
    const startTime = Date.now();

    const eventType = this.getEventType(body.type);
    const eventId = this.getOptionalString(body.id);
    const businessCode = this.getOptionalString(body.businessCode);
    const dedupKey = buildWebhookDedupKey(body);

    // ALS 컨텍스트 설정 — inner retry 루프가 sync-log row 작성 시 사용.
    // next.handle() 의 subscribe 가 ALS scope 안에서 실행돼야 handler 의
    // async chain 이 컨텍스트를 상속받음 (NestJS observable 은 lazy).
    const recordRetry = (record: {
      error: string;
      attempt: number;
      maxAttempts: number;
      extra?: Record<string, unknown>;
    }) => {
      void this.syncLog.add(
        {
          source: 'webhook',
          eventType,
          eventId,
          businessCode,
          areaCode: null,
          showBoxNo: null,
          stgUserId: null,
          stgUnitId: null,
          status: 'error',
          attempt: record.attempt,
          maxAttempts: record.maxAttempts,
          durationMs: Date.now() - startTime,
          error: `[${record.attempt}/${record.maxAttempts}] ${record.error}`,
          payload: {
            ...body,
            _retry: {
              attempt: record.attempt,
              maxAttempts: record.maxAttempts,
              ...(record.extra ?? {}),
            },
          },
        },
        { suppressAlert: true },
      );
    };

    const wrapped$ = new Observable<unknown>((subscriber) =>
      runWithSyncLogContext(
        {
          source: 'webhook',
          eventType,
          eventId,
          businessCode,
          startTime,
          recordRetry,
        },
        () =>
          next.handle().subscribe({
            next: (value) => subscriber.next(value),
            error: (err) => subscriber.error(err),
            complete: () => subscriber.complete(),
          }),
      ),
    );

    return wrapped$.pipe(
      tap(() => {
        const logContext = request.omxWebhookLog ?? {};
        if (logContext.skipLog) return;
        const meta = logContext.syncMeta ?? {};
        const softError = meta?.softError ?? null;
        void this.syncLog.add({
          source: 'webhook',
          eventType,
          eventId,
          businessCode,
          correlationKey: dedupKey,
          areaCode: meta?.areaCode ?? null,
          showBoxNo: meta?.showBoxNo ?? null,
          userName: meta?.userName ?? null,
          stgUserId: meta?.stgUserId ?? null,
          stgUnitId: meta?.stgUnitId ?? null,
          status: softError ? 'error' : 'success',
          durationMs: Date.now() - startTime,
          error: softError,
          payload: this.attachLogMetadata(body, meta),
        });
      }),
      catchError((err: unknown) => {
        const logContext = request.omxWebhookLog ?? {};
        const meta = logContext.syncMeta ?? {};
        const error = err instanceof Error ? err : new Error(String(err));

        // sync-log 기록 (재시도 예정이므로 즉시 알림 skip)
        void this.syncLog.add(
          {
            source: 'webhook',
            eventType,
            eventId,
            businessCode,
            correlationKey: dedupKey,
            areaCode: meta?.areaCode ?? null,
            showBoxNo: meta?.showBoxNo ?? null,
            userName: meta?.userName ?? null,
            stgUserId: meta?.stgUserId ?? null,
            stgUnitId: meta?.stgUnitId ?? null,
            status: 'error',
            durationMs: Date.now() - startTime,
            error: error.message,
            payload: this.attachLogMetadata(body, meta),
          },
          { suppressAlert: true },
        );

        // 웹훅 재시도 스케줄 등록 (비동기, 실패해도 무시)
        void this.scheduledJobRepo
          .createWithoutTransaction({
            eventType: ScheduledJobEventType.WebhookRetry,
            scheduledAt: new Date(Date.now() + 60_000), // 1분 후 재시도
            areaCode: (meta?.areaCode as string) ?? '',
            showBoxNo: (meta?.showBoxNo as number) ?? 0,
            userPhone: null,
            userCode: (meta?.stgUserId as string) ?? null,
            userName: (meta?.userName as string) ?? null,
            payload: body as object,
            sourceEventType: eventType,
            sourceEventId: eventId,
            correlationKey: `webhook-retry:${eventType}:${eventId ?? 'unknown'}`,
            maxAttempts: 3,
          })
          .catch((retryErr: Error) => {
            this.logger.error(
              `[webhook-retry] Failed to create retry job for ${eventType}:${eventId ?? 'unknown'}: ${retryErr.message}`,
            );
          });

        return throwError(() => error);
      }),
    );
  }

  private getBody(body: unknown): LoggedWebhookBody {
    if (typeof body === 'object' && body !== null) {
      return body as LoggedWebhookBody;
    }
    return {};
  }

  private getEventType(value: unknown): string {
    return this.getOptionalString(value) ?? 'unknown';
  }

  private getOptionalString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private attachLogMetadata(
    body: LoggedWebhookBody,
    meta: SyncMeta,
  ): LoggedWebhookBody {
    if (!meta || Object.keys(meta).length === 0) {
      return { ...body };
    }
    return {
      ...body,
      _syncMeta: meta,
    };
  }
}
