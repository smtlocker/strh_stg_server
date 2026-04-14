import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { SyncLogEntry } from './monitoring.types';

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

interface FailureAlertConfig {
  from: string;
  smtp: SmtpConfig;
}

type AlertRow = Pick<
  SyncLogEntry,
  | 'id'
  | 'source'
  | 'eventType'
  | 'eventId'
  | 'correlationKey'
  | 'businessCode'
  | 'areaCode'
  | 'showBoxNo'
  | 'userName'
  | 'stgUserId'
  | 'stgUnitId'
  | 'error'
  | 'replayable'
  | 'alertSentAt'
  | 'alertStatus'
  | 'createdAt'
>;

@Injectable()
export class FailureAlertService implements OnModuleInit {
  private static readonly TERMINAL_STATUSES = new Set([
    'sent',
    'suppressed',
    'disabled',
    'no-recipients',
    'missing-smtp-config',
  ]);
  private static readonly WEBHOOK_RETRY_GRACE_MS = 4000;

  private readonly logger = new Logger(FailureAlertService.name);
  private readonly pendingFinalizers = new Set<number>();
  private transporter: nodemailer.Transporter | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly db: DatabaseService,
    private readonly stgApi: StoreganiseApiService,
  ) {}

  async onModuleInit(): Promise<void> {
    const alerts = this.getAlertConfig();
    if (alerts.smtp.host && alerts.smtp.user && alerts.smtp.pass) {
      this.transporter = nodemailer.createTransport({
        host: alerts.smtp.host,
        port: alerts.smtp.port,
        secure: alerts.smtp.secure,
        auth: {
          user: alerts.smtp.user,
          pass: alerts.smtp.pass,
        },
      });
      this.logger.log(
        `SMTP transporter initialized (${alerts.smtp.host}:${alerts.smtp.port})`,
      );
    }

    try {
      await this.recoverPendingWebhookAlerts();
    } catch (err) {
      this.logger.warn(
        `Skipping pending webhook alert recovery at startup: ${(err as Error).message}`,
      );
    }
  }

  async notifyFinalFailure(entry: SyncLogEntry): Promise<void> {
    if (!entry.id) return;

    if (entry.source === 'webhook') {
      await this.queueWebhookRetryAwareAlert(entry);
      return;
    }

    await this.sendImmediateAlert(entry);
  }

  private async queueWebhookRetryAwareAlert(
    entry: SyncLogEntry,
  ): Promise<void> {
    const current = await this.getAlertRow(entry.id);
    if (!current) return;
    if (this.isTerminalStatus(current.alertStatus)) return;
    if (current.alertStatus !== 'pending-webhook-retry') {
      await this.markAlert(entry.id, 'pending-webhook-retry');
    }

    this.scheduleFinalizer(
      entry.id,
      FailureAlertService.WEBHOOK_RETRY_GRACE_MS,
    );
  }

  private async finalizePendingWebhookFailure(id: number): Promise<void> {
    const entry = await this.getAlertRow(id);
    if (!entry || entry.alertStatus !== 'pending-webhook-retry') {
      return;
    }

    if (
      entry.correlationKey &&
      (await this.hasSuccessfulFollowUp(entry.correlationKey, entry.id))
    ) {
      await this.markAlert(entry.id, 'suppressed');
      return;
    }

    if (
      entry.correlationKey &&
      (await this.hasSentAlertForCorrelation(entry.correlationKey, entry.id))
    ) {
      await this.markAlert(entry.id, 'suppressed');
      return;
    }

    await this.sendImmediateAlert(entry);

    if (entry.correlationKey) {
      await this.suppressOtherPendingAlerts(entry.correlationKey, entry.id);
    }
  }

  private async sendImmediateAlert(
    entry: Pick<
      SyncLogEntry,
      | 'id'
      | 'source'
      | 'eventType'
      | 'correlationKey'
      | 'businessCode'
      | 'areaCode'
      | 'showBoxNo'
      | 'userName'
      | 'stgUserId'
      | 'error'
      | 'replayable'
      | 'alertSentAt'
      | 'alertStatus'
    >,
  ): Promise<void> {
    if (await this.wasAlertAlreadyHandled(entry.id, entry)) {
      this.logger.log(
        `Failure alert already handled for log ${entry.id}, skipping`,
      );
      return;
    }
    if (
      entry.correlationKey &&
      (await this.hasSentAlertForCorrelation(entry.correlationKey, entry.id))
    ) {
      await this.markAlert(entry.id, 'suppressed');
      return;
    }

    const alerts = this.getAlertConfig();
    if (!this.transporter) {
      await this.markAlert(entry.id, 'missing-smtp-config');
      return;
    }

    const recipients = await this.resolveRecipients(entry.businessCode);
    if (!recipients.length) {
      await this.markAlert(entry.id, 'no-recipients');
      return;
    }

    try {
      await this.transporter.sendMail({
        from: alerts.from,
        to: recipients.join(', '),
        subject: `[SmartCube] 실패 알림 - ${entry.eventType}`,
        html: this.buildHtml(entry),
      });

      await this.markAlert(entry.id, 'sent', true);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `Failed to send failure alert for log ${entry.id}: ${message}`,
      );
      await this.markAlert(entry.id, 'error');
    }
  }

  /**
   * 대시보드 표시용 SMTP 설정 조회 (비밀번호 제외).
   */
  getSmtpInfo(): { host: string; port: number; from: string; transporterReady: boolean } {
    const cfg = this.getAlertConfig();
    return {
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      from: cfg.from,
      transporterReady: this.transporter !== null,
    };
  }

  /**
   * 대시보드 테스트 메일 발송. 기존 transporter 인스턴스를 재사용하므로
   * 실제 알람 메일과 동일한 경로로 검증된다.
   */
  async sendTestEmail(
    to: string,
    subject: string,
    body: string,
  ): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
    const cfg = this.getAlertConfig();
    if (!this.transporter) {
      return { ok: false, error: 'SMTP transporter 미초기화 — SMTP_HOST/USER/PASS 설정 후 서버 재시작' };
    }
    const recipient = to.trim();
    if (!recipient) return { ok: false, error: '수신자 이메일을 입력하세요' };

    try {
      const info = await this.transporter.sendMail({
        from: cfg.from,
        to: recipient,
        subject: subject || '[SmartCube] 메일 전송 테스트',
        text: body,
      });
      this.logger.log(`Test email sent to ${recipient} (messageId=${info.messageId})`);
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      const msg = (err as Error).message || String(err);
      this.logger.warn(`Test email failed to ${recipient}: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  private getAlertConfig(): FailureAlertConfig {
    return (
      this.configService.get<FailureAlertConfig>('alerts') ?? {
        from: 'SmartCube Alerts <alerts@smartlocker.co.kr>',
        smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
      }
    );
  }

  /**
   * businessCode(STG site code)로 해당 지점의 admin_email 커스텀 필드를 조회.
   * admin_email 이 없으면 빈 배열 반환 → no-recipients 처리.
   */
  private async resolveRecipients(
    businessCode: string | null,
  ): Promise<string[]> {
    if (!businessCode) return [];

    try {
      const sites = await this.stgApi.getSites();
      const site = sites.find((s) => s.code === businessCode);
      const adminEmail = site?.customFields?.admin_email?.trim();
      if (adminEmail) {
        this.logger.log(
          `Resolved admin_email "${adminEmail}" for site ${businessCode}`,
        );
        return [adminEmail];
      }
    } catch (err) {
      this.logger.warn(
        `Failed to resolve admin_email for site ${businessCode}: ${(err as Error).message}`,
      );
    }

    return [];
  }

  private buildHtml(
    entry: Pick<
      SyncLogEntry,
      | 'id'
      | 'source'
      | 'eventType'
      | 'areaCode'
      | 'showBoxNo'
      | 'userName'
      | 'stgUserId'
      | 'error'
      | 'replayable'
    >,
  ): string {
    const unit =
      entry.areaCode && entry.showBoxNo != null
        ? `${entry.areaCode}:${entry.showBoxNo}`
        : '-';
    const esc = (value: unknown) => {
      const normalized =
        typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : '-';
      return normalized
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    };

    return `
      <div style="font-family:Arial,sans-serif;line-height:1.6">
        <h2 style="margin:0 0 12px">SmartCube 최종 실패 알림</h2>
        <table style="border-collapse:collapse">
          <tr><td style="padding:4px 12px 4px 0"><b>Log ID</b></td><td>${esc(entry.id)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Source</b></td><td>${esc(entry.source)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Event</b></td><td>${esc(entry.eventType)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>User</b></td><td>${esc(entry.userName ?? '-')}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>STG User</b></td><td>${esc(entry.stgUserId ?? '-')}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Unit</b></td><td>${esc(unit)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Error</b></td><td>${esc(entry.error ?? '-')}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Replayable</b></td><td>${entry.replayable ? 'yes' : 'no'}</td></tr>
        </table>
      </div>
    `;
  }

  private async getAlertRow(id: number): Promise<AlertRow | null> {
    const result = await this.db.query<AlertRow>(
      `SELECT TOP 1
          id, source, eventType, eventId, correlationKey, businessCode,
          areaCode, showBoxNo, userName, stgUserId, stgUnitId, error,
          alertSentAt, alertStatus, createdAt
       FROM tblSyncLog
       WHERE id = @id`,
      { id },
    );
    return result.recordset[0] ?? null;
  }

  private async recoverPendingWebhookAlerts(): Promise<void> {
    const result = await this.db.query<Pick<AlertRow, 'id' | 'createdAt'>>(
      `SELECT id, createdAt
       FROM tblSyncLog
       WHERE source = 'webhook'
         AND alertStatus = 'pending-webhook-retry'`,
    );

    const now = Date.now();
    for (const row of result.recordset) {
      const createdAt = new Date(row.createdAt).getTime();
      const elapsed = now - createdAt;
      const delay =
        elapsed >= FailureAlertService.WEBHOOK_RETRY_GRACE_MS
          ? 0
          : FailureAlertService.WEBHOOK_RETRY_GRACE_MS - elapsed;
      this.scheduleFinalizer(row.id, delay);
    }
  }

  private async hasSuccessfulFollowUp(
    correlationKey: string,
    failedId: number,
  ): Promise<boolean> {
    const result = await this.db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM tblSyncLog
       WHERE correlationKey = @correlationKey
         AND status = 'success'
         AND id > @failedId`,
      { correlationKey, failedId },
    );
    return (result.recordset[0]?.cnt ?? 0) > 0;
  }

  private async hasSentAlertForCorrelation(
    correlationKey: string,
    excludedId: number,
  ): Promise<boolean> {
    const result = await this.db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM tblSyncLog
       WHERE correlationKey = @correlationKey
         AND id <> @excludedId
         AND alertStatus = 'sent'`,
      { correlationKey, excludedId },
    );
    return (result.recordset[0]?.cnt ?? 0) > 0;
  }

  private async suppressOtherPendingAlerts(
    correlationKey: string,
    sentId: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE tblSyncLog
       SET alertStatus = 'suppressed'
       WHERE correlationKey = @correlationKey
         AND id <> @sentId
         AND alertStatus = 'pending-webhook-retry'`,
      { correlationKey, sentId },
    );
  }

  private async wasAlertAlreadyHandled(
    id: number,
    entry: Pick<SyncLogEntry, 'alertSentAt' | 'alertStatus'>,
  ): Promise<boolean> {
    if (entry.alertSentAt || this.isTerminalStatus(entry.alertStatus)) {
      return true;
    }

    const result = await this.db.query<{
      alertSentAt: Date | null;
      alertStatus: string | null;
    }>(
      `SELECT TOP 1 alertSentAt, alertStatus
       FROM tblSyncLog
       WHERE id = @id`,
      { id },
    );

    const row = result.recordset[0];
    return (
      !!row?.alertSentAt || this.isTerminalStatus(row?.alertStatus ?? null)
    );
  }

  private isTerminalStatus(status: string | null | undefined): boolean {
    return status != null && FailureAlertService.TERMINAL_STATUSES.has(status);
  }

  private scheduleFinalizer(id: number, delayMs: number): void {
    if (this.pendingFinalizers.has(id)) return;
    this.pendingFinalizers.add(id);

    setTimeout(() => {
      void this.finalizePendingWebhookFailure(id)
        .catch((err: Error) => {
          this.logger.error(
            `Failed to finalize webhook alert for log ${id}: ${err.message}`,
          );
        })
        .finally(() => {
          this.pendingFinalizers.delete(id);
        });
    }, delayMs);
  }

  private async markAlert(
    id: number,
    status: string,
    sent = false,
  ): Promise<void> {
    await this.db.query(
      `UPDATE tblSyncLog
       SET alertStatus = @status,
           alertSentAt = ${sent ? 'GETDATE()' : 'alertSentAt'}
       WHERE id = @id`,
      { id, status },
    );
  }
}
