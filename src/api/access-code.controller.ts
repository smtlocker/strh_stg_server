import {
  Controller,
  Put,
  Body,
  Logger,
  HttpCode,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
} from '@nestjs/swagger';
import { UpdateAccessCodeDto } from './dto/update-access-code.dto';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { resolveUnitMapping } from '../common/utils';
import {
  insertBoxHistorySnapshot,
  officeCodeToAreaPrefix,
} from '../common/db-utils';
import { StgEventType } from '../common/event-types';
import { SyncLogService } from '../monitoring/sync-log.service';
import * as sql from 'mssql';

@ApiTags('access-code')
@Controller('api')
export class AccessCodeController {
  private readonly logger = new Logger(AccessCodeController.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly sgApi: StoreganiseApiService,
    private readonly syncLog: SyncLogService,
  ) {}

  /**
   * PTI 조회로 대시보드 표시용 사용자/유닛 정보 해석.
   * - userName: 같은 StgUserId 는 단일 사용자이므로 어느 row 에서든 첫 non-null 값 사용
   * - areaCode/showBoxNo: PTI row 가 정확히 1건일 때만 set (다중 유닛이면 모호하므로 null)
   * 조회 실패해도 메인 흐름을 깨지 않도록 try/catch → 모두 null 반환.
   */
  private async resolveUserInfo(
    stgUserId: string,
    officeCode: string,
  ): Promise<{
    userName: string | null;
    areaCode: string | null;
    showBoxNo: number | null;
  }> {
    try {
      const r = await this.db.query<{
        AreaCode: string;
        showBoxNo: number;
        UserName: string | null;
      }>(
        `SELECT AreaCode, showBoxNo, UserName FROM tblPTIUserInfo
         WHERE StgUserId = @stgUserId AND OfficeCode = @officeCode`,
        { stgUserId, officeCode },
      );
      const rows = r.recordset;
      if (rows.length === 0) {
        return { userName: null, areaCode: null, showBoxNo: null };
      }
      const userName = rows.find((x) => x.UserName)?.UserName ?? null;
      return {
        userName,
        areaCode: rows.length === 1 ? rows[0].AreaCode : null,
        showBoxNo: rows.length === 1 ? rows[0].showBoxNo : null,
      };
    } catch {
      return { userName: null, areaCode: null, showBoxNo: null };
    }
  }

  /**
   * PUT /api/access-code 호출 결과를 tblSyncLog 에 기록.
   * source='api', eventType='api.access-code.update'. PTI 가 단일 유닛이면
   * areaCode/showBoxNo 도 채워 대시보드에서 지점/유닛 표시되도록 한다.
   */
  private async logAccessCodeChange(params: {
    stgUserId: string;
    officeCode: string;
    accessCode: string;
    requestId: string;
    durationMs: number;
    status: 'success' | 'error';
    error?: string | null;
    extra?: Record<string, unknown>;
    areaCode?: string | null;
    showBoxNo?: number | null;
    userName?: string | null;
  }): Promise<void> {
    try {
      await this.syncLog.add(
        {
          source: 'api',
          eventType: 'api.access-code.update',
          eventId: params.requestId,
          correlationKey: `api:access-code:${params.stgUserId}:${params.officeCode}`,
          businessCode: null,
          areaCode: params.areaCode ?? null,
          showBoxNo: params.showBoxNo ?? null,
          userName: params.userName ?? null,
          stgUserId: params.stgUserId,
          stgUnitId: null,
          status: params.status,
          durationMs: params.durationMs,
          error: params.error ?? null,
          payload: {
            officeCode: params.officeCode,
            accessCode: params.accessCode,
            ...(params.extra ?? {}),
          },
        },
        { suppressAlert: params.status === 'success' },
      );
    } catch (logErr) {
      // syncLog 실패는 메인 응답을 깨뜨리지 않는다.
      this.logger.warn(
        `[updateAccessCode] syncLog.add failed: ${(logErr as Error).message}`,
      );
    }
  }

  @Put('access-code')
  @HttpCode(200)
  @ApiOperation({
    summary: '게이트 AccessCode 변경',
    description:
      '호호락 통합 매니저가 특정 사용자의 특정 지점 게이트 PIN 을 변경한다. 흐름: ① 지점 내 AccessCode 중복 검사 → ② tblPTIUserInfo UPDATE (StgUserId+OfficeCode 기준) → ③ 해당 사용자의 활성 유닛(useState 1/3) tblBoxHistory 스냅샷 기록 → ④ STG `/v1/admin/unit-rentals` 에 `customFields.gate_code` 푸시. **STG 호출까지 DB 트랜잭션 내부에서 수행**하며 어느 단계든 실패하면 DB 는 rollback 되고 `status: error` 와 사유가 반환된다.',
  })
  @ApiBody({ type: UpdateAccessCodeDto })
  @ApiResponse({
    status: 200,
    description:
      'status 로 2가지 분기. ok = DB + STG 모두 성공 / error = 중복 · PTI 미발견 · DB 에러 · STG 실패 — DB 는 롤백된 상태',
    schema: {
      oneOf: [
        {
          title: 'ok',
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['ok'] },
          },
          example: { status: 'ok' },
        },
        {
          title: 'error',
          type: 'object',
          required: ['status', 'message'],
          properties: {
            status: { type: 'string', enum: ['error'] },
            message: {
              type: 'string',
              example:
                'AccessCode 123456 is already in use in office 0002',
            },
          },
        },
      ],
    },
  })
  async updateAccessCode(
    @Body() dto: UpdateAccessCodeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { stgUserId, officeCode, accessCode } = dto;
    const startTime = Date.now();
    // 호출별 고유 식별자 — syncLog.eventId + 응답 헤더(X-Request-Id) 둘 다에 사용.
    // 호출자가 X-Request-Id 를 보내면 그 값을 재사용, 없으면 uuid 발급.
    const incoming = res.req?.header('x-request-id');
    const requestId = incoming && incoming.trim() ? incoming.trim() : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    this.logger.log(
      `[updateAccessCode] requestId=${requestId} stgUserId=${stgUserId} officeCode=${officeCode} accessCode=${accessCode}`,
    );

    // 1. 지점 내 AccessCode 중복 확인 (트랜잭션 밖 — 읽기 전용)
    const dupCheck = await this.db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM tblPTIUserInfo
       WHERE OfficeCode = @officeCode
         AND AccessCode = @accessCode
         AND Enable = 1
         AND (StgUserId IS NULL OR StgUserId <> @stgUserId)`,
      { officeCode, accessCode, stgUserId },
    );
    if (dupCheck.recordset[0]?.cnt > 0) {
      const message = `AccessCode ${accessCode} is already in use in office ${officeCode}`;
      const userInfo = await this.resolveUserInfo(stgUserId, officeCode);
      await this.logAccessCodeChange({
        stgUserId,
        officeCode,
        accessCode,
        requestId,
        durationMs: Date.now() - startTime,
        status: 'error',
        error: message,
        extra: { reason: 'duplicate' },
        ...userInfo,
      });
      return { status: 'error', message };
    }

    // DB + STG 를 하나의 원자 단위로 — STG 실패 시 DB 도 rollback.
    // trade-off: STG API 호출 동안 DB 트랜잭션이 열려있어 connection/lock 을 더 오래 잡는다.
    const transaction = await this.db.beginTransaction();
    try {
      // 2. tblPTIUserInfo UPDATE (StgUserId + OfficeCode 기준)
      const updateResult = await new sql.Request(transaction)
        .input('stgUserId', sql.NVarChar, stgUserId)
        .input('officeCode', sql.NVarChar, officeCode)
        .input('accessCode', sql.NVarChar, accessCode)
        .query(
          `UPDATE tblPTIUserInfo
           SET AccessCode = @accessCode, UpdateTime = GETDATE()
           WHERE StgUserId = @stgUserId AND OfficeCode = @officeCode`,
        );

      const rowsAffected = updateResult.rowsAffected[0];
      if (rowsAffected === 0) {
        await transaction.rollback();
        const message = `No PTI record found for stgUserId=${stgUserId} in office ${officeCode}`;
        this.logger.warn(`[updateAccessCode] ${message}`);
        await this.logAccessCodeChange({
          stgUserId,
          officeCode,
          accessCode,
          requestId,
          durationMs: Date.now() - startTime,
          status: 'error',
          error: message,
          extra: { reason: 'pti-not-found' },
        });
        return { status: 'error', message };
      }

      // 3. tblBoxHistory 스냅샷 — 해당 사용자의 해당 지점 유닛 찾아서 기록
      const units = await new sql.Request(transaction)
        .input('stgUserId', sql.NVarChar, stgUserId)
        .input(
          'areaPrefix',
          sql.NVarChar,
          officeCodeToAreaPrefix(officeCode) + '%',
        )
        .query<{ areaCode: string; showBoxNo: number }>(
          `SELECT bm.areaCode, bm.showBoxNo
           FROM tblBoxMaster bm
           WHERE bm.userCode = @stgUserId
             AND bm.areaCode LIKE @areaPrefix
             AND bm.useState IN (1, 3)`,
        );

      for (const unit of units.recordset) {
        await insertBoxHistorySnapshot(
          transaction,
          unit.areaCode,
          unit.showBoxNo,
          StgEventType.PinManual,
        );
      }

      // 4. STG rental 동기화 — 트랜잭션 내부. 실패 시 throw → catch 에서 rollback.
      const allRentals = await this.sgApi.getUserRentals(stgUserId);
      let syncCount = 0;
      for (const rental of allRentals) {
        const rUnit = await this.sgApi.getUnit(rental.unitId);
        const rParsed = await resolveUnitMapping(this.sgApi, rUnit);
        if (!rParsed || rParsed.officeCode !== officeCode) continue;

        await this.sgApi.updateUnitRental(rental.id, {
          customFields: { gate_code: accessCode },
        });
        syncCount++;
      }

      // 5. 모두 성공 → commit
      await transaction.commit();
      this.logger.log(
        `[updateAccessCode] success: ${rowsAffected} PTI row(s), ${units.recordset.length} history snapshot(s), ${syncCount} STG rental(s)`,
      );
      const userInfo = await this.resolveUserInfo(stgUserId, officeCode);
      await this.logAccessCodeChange({
        stgUserId,
        officeCode,
        accessCode,
        requestId,
        durationMs: Date.now() - startTime,
        status: 'success',
        extra: {
          ptiRowsAffected: rowsAffected,
          historySnapshotCount: units.recordset.length,
          stgSyncCount: syncCount,
        },
        ...userInfo,
      });
      return { status: 'ok' };
    } catch (err) {
      const message = (err as Error).message || String(err);
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        this.logger.warn(
          `[updateAccessCode] rollback also failed: ${(rollbackErr as Error).message}`,
        );
      }
      this.logger.error(`[updateAccessCode] rolled back: ${message}`);
      const userInfo = await this.resolveUserInfo(stgUserId, officeCode);
      await this.logAccessCodeChange({
        stgUserId,
        officeCode,
        accessCode,
        requestId,
        durationMs: Date.now() - startTime,
        status: 'error',
        error: message,
        extra: { reason: 'transaction-rollback' },
        ...userInfo,
      });
      return { status: 'error', message };
    }
  }
}
