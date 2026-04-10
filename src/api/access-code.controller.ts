import {
  Controller,
  Put,
  Body,
  Logger,
  HttpCode,
} from '@nestjs/common';
import { UpdateAccessCodeDto } from './dto/update-access-code.dto';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { resolveUnitMapping } from '../common/utils';
import {
  insertBoxHistorySnapshot,
  officeCodeToAreaPrefix,
} from '../common/db-utils';
import * as sql from 'mssql';

@Controller('api')
export class AccessCodeController {
  private readonly logger = new Logger(AccessCodeController.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly sgApi: StoreganiseApiService,
  ) {}

  /**
   * PUT /api/access-code
   * 호호락 통합 매니저 → 특정 사용자의 특정 지점 게이트 PIN 변경
   */
  @Put('access-code')
  @HttpCode(200)
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
