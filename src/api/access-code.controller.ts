import {
  Controller,
  Put,
  Body,
  Logger,
  HttpCode,
} from '@nestjs/common';
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
import * as sql from 'mssql';

@ApiTags('access-code')
@Controller('api')
export class AccessCodeController {
  private readonly logger = new Logger(AccessCodeController.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly sgApi: StoreganiseApiService,
  ) {}

  @Put('access-code')
  @HttpCode(200)
  @ApiOperation({
    summary: '게이트 AccessCode 변경',
    description:
      '호호락 통합 매니저가 특정 사용자의 특정 지점 게이트 PIN 을 변경한다. 흐름: ① 지점 내 AccessCode 중복 검사 → ② tblPTIUserInfo UPDATE (StgUserId+OfficeCode 기준) → ③ 해당 사용자의 활성 유닛(useState 1/3) tblBoxHistory 스냅샷 기록 → ④ STG `/v1/admin/unit-rentals` 에 `customFields.gate_code` 푸시. STG 동기화가 실패해도 DB 트랜잭션은 커밋된 상태로 `status: partial` 응답.',
  })
  @ApiBody({ type: UpdateAccessCodeDto })
  @ApiResponse({
    status: 200,
    description:
      'status 로 3가지 분기. ok = 성공, partial = DB 반영 후 STG 푸시 실패, error = 중복/PTI 미발견 등 업무 에러',
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
          title: 'partial',
          type: 'object',
          required: ['status', 'message', 'error'],
          properties: {
            status: { type: 'string', enum: ['partial'] },
            message: {
              type: 'string',
              example: 'DB updated but STG sync failed',
            },
            error: {
              type: 'string',
              description: 'STG API 실패 메시지 원문',
            },
          },
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
  async updateAccessCode(@Body() dto: UpdateAccessCodeDto) {
    const { stgUserId, officeCode, accessCode } = dto;
    this.logger.log(
      `[updateAccessCode] stgUserId=${stgUserId} officeCode=${officeCode} accessCode=${accessCode}`,
    );

    // 1. 지점 내 AccessCode 중복 확인
    const dupCheck = await this.db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM tblPTIUserInfo
       WHERE OfficeCode = @officeCode
         AND AccessCode = @accessCode
         AND Enable = 1
         AND (StgUserId IS NULL OR StgUserId <> @stgUserId)`,
      { officeCode, accessCode, stgUserId },
    );
    if (dupCheck.recordset[0]?.cnt > 0) {
      return {
        status: 'error',
        message: `AccessCode ${accessCode} is already in use in office ${officeCode}`,
      };
    }

    // 2. tblPTIUserInfo UPDATE (StgUserId + OfficeCode 기준)
    const transaction = await this.db.beginTransaction();
    try {
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
        this.logger.warn(
          `[updateAccessCode] No PTI record found for stgUserId=${stgUserId} officeCode=${officeCode}`,
        );
        return {
          status: 'error',
          message: `No PTI record found for stgUserId=${stgUserId} in office ${officeCode}`,
        };
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
          139,
        );
      }

      await transaction.commit();
      this.logger.log(
        `[updateAccessCode] DB updated: ${rowsAffected} PTI row(s), ${units.recordset.length} history snapshot(s)`,
      );
    } catch (err) {
      await transaction.rollback();
      this.logger.error(
        `[updateAccessCode] Transaction failed: ${(err as Error).message}`,
      );
      throw err;
    }

    // 4. STG rental 동기화 — 해당 사용자의 해당 지점 rental에 accessCode 푸시
    try {
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

      this.logger.log(
        `[updateAccessCode] STG synced: ${syncCount} rental(s) updated`,
      );
    } catch (err) {
      // STG 동기화 실패해도 DB는 이미 커밋됨 — 로그만 남기고 응답에 포함
      this.logger.error(
        `[updateAccessCode] STG sync failed: ${(err as Error).message}`,
      );
      return {
        status: 'partial',
        message: 'DB updated but STG sync failed',
        error: (err as Error).message,
      };
    }

    return { status: 'ok' };
  }
}
