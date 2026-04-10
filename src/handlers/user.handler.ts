import { Injectable, Logger } from '@nestjs/common';
import { WebhookHandler } from './handler.interface';
import { WebhookPayloadDto } from '../webhook/dto/webhook-payload.dto';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { SyncMeta } from '../monitoring/monitoring.types';
import { normalizePhone, formatName } from '../common/utils';
import { safeRollback } from '../common/db-utils';
import * as sql from 'mssql';

@Injectable()
export class UserHandler implements WebhookHandler {
  private readonly logger = new Logger(UserHandler.name);

  // 우리가 신경 쓰는 STG 사용자 필드. 이 필드들 중 하나라도 changedKeys 에 포함돼야
  // 처리. `language`, `timezone` 등 비관련 변경은 조용히 skip (Q4 정책 보조).
  private static readonly RELEVANT_CHANGE_KEYS = new Set<string>([
    'phone',
    'phoneNumber',
    'firstName',
    'lastName',
    'first_name',
    'last_name',
    'name',
  ]);

  constructor(
    private readonly db: DatabaseService,
    private readonly sgApi: StoreganiseApiService,
  ) {}

  async handle(payload: WebhookPayloadDto): Promise<SyncMeta | void> {
    switch (payload.type) {
      case 'user.updated':
        return this.handleUserUpdated(payload);

      default:
        this.logger.warn(
          `UserHandler received unhandled event type: ${payload.type}`,
        );
    }
  }

  private async handleUserUpdated(
    payload: WebhookPayloadDto,
  ): Promise<SyncMeta | void> {
    const userId = payload.data?.userId;
    if (!userId) {
      const reason = 'missing userId in user.updated payload';
      this.logger.warn(reason);
      return { softError: reason };
    }

    // C 필터: changedKeys 에 우리가 신경 쓰는 필드가 없으면 조용히 skip.
    // STG 는 language/timezone 등 모든 변경에 user.updated 를 발사하므로,
    // 우리와 무관한 변경은 STG API 호출도 생략하고 성공 처리.
    const changedKeys = (payload.data?.changedKeys as string[] | undefined) ?? [];
    const hasRelevantChange =
      changedKeys.length === 0 ||
      changedKeys.some((k) => UserHandler.RELEVANT_CHANGE_KEYS.has(k));
    if (!hasRelevantChange) {
      this.logger.log(
        `user.updated: skipping userId=${userId} — no relevant field changed (changedKeys=${JSON.stringify(changedKeys)})`,
      );
      return { stgUserId: userId };
    }

    try {
      const user = await this.sgApi.getUser(userId);

      const rawPhone =
        (user['phone'] as string) ?? (user['phoneNumber'] as string) ?? '';
      const rawLastName =
        (user['lastName'] as string) ?? (user['last_name'] as string) ?? '';
      const rawFirstName =
        (user['firstName'] as string) ?? (user['first_name'] as string) ?? '';

      const userPhone = normalizePhone(rawPhone);
      const userName = formatName(rawLastName, rawFirstName);

      // A 체크: 우리 DB 에 해당 사용자 row 가 하나도 없으면 조용히 skip.
      // STG 는 어드민/스태프/테스트 계정에도 user.updated 를 발사하므로,
      // 우리가 추적하지 않는 사용자는 성공 처리 (실패 아님).
      // 매칭: stgUserId 우선 + phone fallback (legacy rows with null StgUserId).
      const trackedResult = await this.db.query<{ cnt: number }>(
        `SELECT (
           (SELECT COUNT(*) FROM tblPTIUserInfo
            WHERE StgUserId = @stgUserId
               OR (@userPhone <> '' AND StgUserId IS NULL AND UserPhone = @userPhone))
           +
           (SELECT COUNT(*) FROM tblBoxMaster
            WHERE userCode = @stgUserId
               OR (@userPhone <> '' AND (userCode IS NULL OR userCode = '') AND userPhone = @userPhone))
         ) AS cnt`,
        { stgUserId: userId, userPhone: userPhone || '' },
      );
      const trackedCnt = trackedResult.recordset[0]?.cnt ?? 0;
      if (trackedCnt === 0) {
        this.logger.log(
          `user.updated: skipping userId=${userId} — not tracked in our DB (no matching rows by stgUserId or phone)`,
        );
        return { stgUserId: userId, userName };
      }

      // 추적 중인 사용자인데 STG 에 phone 이 없는 경우 (데이터 이상) → 조용히 skip.
      // 이전 동작 (softError) 은 대시보드에 실패로 표시돼서 노이즈 발생.
      if (!userPhone) {
        this.logger.log(
          `user.updated: skipping userId=${userId} — tracked but phone missing in STG`,
        );
        return { stgUserId: userId, userName };
      }

      const transaction = await this.db.beginTransaction();
      try {
        // 1. tblPTIUserInfo — StgUserId 기준 매칭 우선
        const ptiReq1 = new sql.Request(transaction);
        ptiReq1.input('userName', sql.NVarChar, userName);
        ptiReq1.input('userPhone', sql.NVarChar, userPhone);
        ptiReq1.input('stgUserId', sql.NVarChar, userId);
        let ptiResult = await ptiReq1.query(
          `UPDATE tblPTIUserInfo
              SET UserName   = @userName,
                  UserPhone  = @userPhone,
                  UpdateTime = GETDATE()
            WHERE StgUserId = @stgUserId`,
        );
        let ptiRows = ptiResult.rowsAffected[0];

        // StgUserId 매칭 실패 시 phone fallback (+ StgUserId 설정)
        if (ptiRows === 0) {
          const ptiReq2 = new sql.Request(transaction);
          ptiReq2.input('userName', sql.NVarChar, userName);
          ptiReq2.input('stgUserId', sql.NVarChar, userId);
          ptiReq2.input('userPhone', sql.NVarChar, userPhone);
          ptiResult = await ptiReq2.query(
            `UPDATE tblPTIUserInfo
                SET UserName   = @userName,
                    StgUserId  = @stgUserId,
                    UpdateTime = GETDATE()
              WHERE UserPhone = @userPhone AND StgUserId IS NULL`,
          );
          ptiRows = ptiResult.rowsAffected[0];
          if (ptiRows > 0) {
            this.logger.log(
              `user.updated: StgUserId=${userId} set via phone fallback (${ptiRows} rows)`,
            );
          }
        }

        // 2. tblBoxMaster — userCode(=StgUserId) 기준 매칭 우선
        const boxReq1 = new sql.Request(transaction);
        boxReq1.input('userName', sql.NVarChar, userName);
        boxReq1.input('userPhone', sql.NVarChar, userPhone);
        boxReq1.input('stgUserId', sql.NVarChar, userId);
        let boxResult = await boxReq1.query(
          `UPDATE tblBoxMaster
              SET userName   = @userName,
                  userPhone  = @userPhone,
                  updateTime = GETDATE()
            WHERE userCode = @stgUserId`,
        );
        let boxRows = boxResult.rowsAffected[0];

        // userCode 매칭 실패 시 phone fallback (+ userCode에 stgUserId 설정)
        if (boxRows === 0) {
          const boxReq2 = new sql.Request(transaction);
          boxReq2.input('userName', sql.NVarChar, userName);
          boxReq2.input('stgUserId', sql.NVarChar, userId);
          boxReq2.input('userPhone', sql.NVarChar, userPhone);
          boxResult = await boxReq2.query(
            `UPDATE tblBoxMaster
                SET userName   = @userName,
                    userCode   = @stgUserId,
                    updateTime = GETDATE()
              WHERE userPhone = @userPhone
                AND (userCode = @userPhone OR userCode IS NULL OR userCode = '')`,
          );
          boxRows = boxResult.rowsAffected[0];
        }

        await transaction.commit();

        this.logger.log(
          `user.updated: userId=${userId}, phone=${userPhone}, name="${userName}". PTI rows: ${ptiRows}, BOX rows: ${boxRows}.`,
        );
      } catch (err) {
        await safeRollback(transaction);
        throw err;
      }

      return { userName, stgUserId: userId };
    } catch (err) {
      this.logger.error(
        `user.updated: failed to process userId=${userId}. Error: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    }
  }
}
