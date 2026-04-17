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

    // C 필터: changedKeys 에 우리가 신경 쓰는 필드 (phone/name 계열) 가 없으면 DB 를
    // 건드리지 않는다. 대신 대시보드 로그에 사용자명이 비지 않도록 STG 에서 이름만
    // 한번 조회해서 syncMeta 에 채운다. language/timezone/labels 등 비관련 변경도
    // 운영자가 누구의 변경인지 눈으로 확인할 수 있게 하는 용도.
    const changedKeys = (payload.data?.changedKeys as string[] | undefined) ?? [];
    const hasRelevantChange =
      changedKeys.length === 0 ||
      changedKeys.some((k) => UserHandler.RELEVANT_CHANGE_KEYS.has(k));
    if (!hasRelevantChange) {
      let userName: string | undefined;
      try {
        const user = await this.sgApi.getUser(userId);
        userName = formatName(
          (user['lastName'] as string) ?? (user['last_name'] as string) ?? '',
          (user['firstName'] as string) ?? (user['first_name'] as string) ?? '',
        );
      } catch (err) {
        this.logger.warn(
          `user.updated: name lookup failed for userId=${userId} — ${(err as Error).message}`,
        );
      }
      this.logger.log(
        `user.updated: no-op (non-relevant) userId=${userId} userName="${userName ?? ''}" changedKeys=${JSON.stringify(changedKeys)}`,
      );
      return {
        stgUserId: userId,
        userName,
        noopReason: `changedKeys=[${changedKeys.join(', ')}] — phone/name 계열 변경 아님`,
      };
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
        return {
          stgUserId: userId,
          userName,
          noopReason:
            '호호락 DB 에서 추적되지 않는 사용자 — tblPTIUserInfo / tblBoxMaster 에 매칭 row 없음',
        };
      }

      const transaction = await this.db.beginTransaction();
      try {
        // 1. tblPTIUserInfo — StgUserId 기준 UPDATE. STG 에 phone 이 없어도
        //    (userPhone='') 이름 업데이트는 반드시 진행. phone 이 빈 값이면
        //    DB 의 UserPhone 도 빈 문자열로 수렴.
        const ptiReq1 = new sql.Request(transaction);
        ptiReq1.input('userName', sql.NVarChar, userName);
        ptiReq1.input('userPhone', sql.NVarChar, userPhone);
        ptiReq1.input('stgUserId', sql.NVarChar, userId);
        // STG 에 phone 이 없으면 DB 의 기존 UserPhone 을 유지 (덮어쓰기 금지).
        let ptiResult = await ptiReq1.query(
          `UPDATE tblPTIUserInfo
              SET UserName   = @userName,
                  UserPhone  = CASE WHEN LEN(@userPhone) > 0 THEN @userPhone ELSE UserPhone END,
                  UpdateTime = GETDATE()
            WHERE StgUserId = @stgUserId`,
        );
        let ptiRows = ptiResult.rowsAffected[0];

        // StgUserId 매칭 실패 + STG 에 phone 이 있을 때만 phone fallback.
        // phone 이 빈 값이면 fallback 자체가 의미 없으므로 건너뛴다.
        if (ptiRows === 0 && userPhone) {
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

        // 2. tblBoxMaster — userCode(=StgUserId) 기준 UPDATE. phone 없어도 이름 갱신.
        const boxReq1 = new sql.Request(transaction);
        boxReq1.input('userName', sql.NVarChar, userName);
        boxReq1.input('userPhone', sql.NVarChar, userPhone);
        boxReq1.input('stgUserId', sql.NVarChar, userId);
        // STG 에 phone 이 없으면 DB 의 기존 userPhone 을 유지.
        let boxResult = await boxReq1.query(
          `UPDATE tblBoxMaster
              SET userName   = @userName,
                  userPhone  = CASE WHEN LEN(@userPhone) > 0 THEN @userPhone ELSE userPhone END,
                  updateTime = GETDATE()
            WHERE userCode = @stgUserId`,
        );
        let boxRows = boxResult.rowsAffected[0];

        // userCode 매칭 실패 + STG 에 phone 이 있을 때만 phone fallback.
        if (boxRows === 0 && userPhone) {
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
