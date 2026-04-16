import { Injectable, Logger } from '@nestjs/common';
import { WebhookHandler } from './handler.interface';
import { WebhookPayloadDto } from '../webhook/dto/webhook-payload.dto';
import { DatabaseService } from '../database/database.service';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { SyncMeta } from '../monitoring/monitoring.types';
import {
  resolveUnitMapping,
  normalizePhone,
  extractUserInfo,
} from '../common/utils';
import {
  insertBoxHistorySnapshot,
  generateUniqueAccessCode,
  setPtiUserEnableAllForGroup,
  safeRollback,
} from '../common/db-utils';
import { StgEventType } from '../common/event-types';
import * as sql from 'mssql';

@Injectable()
export class RentalUpdatedHandler implements WebhookHandler {
  private readonly logger = new Logger(RentalUpdatedHandler.name);
  private static readonly OVERLOCK_IN_PROGRESS = 'in progress';
  private static readonly OVERLOCK_ACTIVE = 'overlocked';
  private static readonly OVERLOCK_REMOVED = 'overlock removed';

  constructor(
    private readonly db: DatabaseService,
    private readonly sgApi: StoreganiseApiService,
  ) {}

  async handle(payload: WebhookPayloadDto): Promise<SyncMeta | void> {
    const changedKeys = payload.data?.changedKeys;
    if (!changedKeys || changedKeys.length === 0) {
      this.logger.log('unitRental.updated: no changedKeys, skipping');
      return;
    }

    const rentalId = payload.data?.unitRentalId;
    if (!rentalId) {
      const reason = 'missing unitRentalId in unitRental.updated payload';
      this.logger.warn(reason);
      return { softError: reason };
    }

    this.logger.log(
      `unitRental.updated: rentalId=${rentalId} changedKeys=[${changedKeys.join(', ')}]`,
    );

    const rental = await this.sgApi.getUnitRental(rentalId);
    const unitId = rental.unitId;
    const ownerId = rental['ownerId'] as string;
    const rentalCustomFields = (rental['customFields'] ?? {}) as Record<
      string,
      unknown
    >;
    let parsedCache:
      | { areaCode: string; showBoxNo: number; officeCode: string }
      | null
      | undefined;
    const getParsed = async () => {
      if (parsedCache !== undefined) return parsedCache;

      const unit = await this.sgApi.getUnit(unitId);
      parsedCache = await resolveUnitMapping(this.sgApi, unit);
      return parsedCache;
    };

    let userNameCache: string | undefined;
    const getUserName = async () => {
      if (userNameCache !== undefined) return userNameCache;
      const user = await this.sgApi.getUser(ownerId);
      const { userName } = extractUserInfo(user);
      userNameCache = userName;
      return userName;
    };

    // -------------------------------------------------------------------------
    // 시나리오 #8: Gate Pin Code Regeneration (Q18 — 시나리오 기준 유일한 활성 플로우)
    // -------------------------------------------------------------------------
    if (changedKeys.includes('customFields.smartcube_generateAccessCode')) {
      const shouldGenerate =
        rentalCustomFields['smartcube_generateAccessCode'] === true;

      if (shouldGenerate) {
        const parsed = await getParsed();
        if (!parsed) {
          const reason = `smartcube_id missing or invalid for unit ${unitId} (generateAccessCode flow)`;
          this.logger.warn(`unitRental.updated: ${reason}, skipping`);
          return { softError: reason, stgUnitId: unitId };
        }
        const { areaCode, showBoxNo, officeCode } = parsed;
        const user = await this.sgApi.getUser(ownerId);
        const userPhone = normalizePhone((user['phone'] as string) ?? '');
        userNameCache = extractUserInfo(user).userName;

        let accessCode: string;
        const transaction = await this.db.beginTransaction();
        try {
          accessCode = await generateUniqueAccessCode(transaction, officeCode);

          const pinReq = new sql.Request(transaction);
          pinReq.input('accessCode', sql.NVarChar, accessCode);
          pinReq.input('officeCode', sql.NVarChar, officeCode);
          pinReq.input('userPhone', sql.NVarChar, userPhone);
          pinReq.input('stgUserId', sql.NVarChar, ownerId);
          await pinReq.query(
            `UPDATE tblPTIUserInfo SET AccessCode=@accessCode, UpdateTime=GETDATE()
             WHERE OfficeCode=@officeCode AND StgUserId=@stgUserId`,
          );

          await insertBoxHistorySnapshot(
            transaction,
            areaCode,
            showBoxNo,
            StgEventType.PinAuto,
          );

          await transaction.commit();
          this.logger.log(
            `smartcube_generateAccessCode: new PIN generated and saved for areaCode=${areaCode} showBoxNo=${showBoxNo}`,
          );
        } catch (err) {
          await safeRollback(transaction);
          this.logger.error(
            `Failed to generate/save accessCode for areaCode=${areaCode} showBoxNo=${showBoxNo}: ${(err as Error).message}`,
          );
          throw err;
        }

        // 같은 고객의 같은 지점 내 모든 rental에 accessCode 푸시
        const allRentals = await this.sgApi.getUserRentals(ownerId);
        let updatedCount = 0;
        for (const r of allRentals) {
          const rUnit = await this.sgApi.getUnit(r.unitId);
          const rParsed = await resolveUnitMapping(this.sgApi, rUnit);
          if (!rParsed) continue;

          if (rParsed.officeCode !== officeCode) continue;

          const updateBody: Record<string, unknown> = {
            customFields: { gate_code: accessCode },
          };
          if (r.id === rentalId) {
            (
              updateBody.customFields as Record<string, unknown>
            ).smartcube_generateAccessCode = false;
          }
          await this.sgApi.updateUnitRental(r.id, updateBody);
          updatedCount++;
        }
        this.logger.log(
          `smartcube_generateAccessCode: accessCode pushed to ${updatedCount} rental(s) in office ${officeCode}`,
        );
      } else {
        this.logger.log(
          `smartcube_generateAccessCode is false for rental ${rentalId}, no action taken`,
        );
      }
    }

    // -------------------------------------------------------------------------
    // Manual Overlock / Remove Overlock by Staff
    // smartcube_lockUnit / smartcube_unlockUnit 체크박스 감지
    // -------------------------------------------------------------------------
    const lockChanged = changedKeys.includes('customFields.smartcube_lockUnit');
    const unlockChanged = changedKeys.includes(
      'customFields.smartcube_unlockUnit',
    );

    if (lockChanged || unlockChanged) {
      const lockRequested = rentalCustomFields['smartcube_lockUnit'] === true;
      const unlockRequested =
        rentalCustomFields['smartcube_unlockUnit'] === true;
      const currentStatus = rentalCustomFields['smartcube_lockStatus'] as
        | string
        | undefined;

      // 처리중이면 중단
      if (
        currentStatus === RentalUpdatedHandler.OVERLOCK_IN_PROGRESS ||
        currentStatus === 'in process'
      ) {
        this.logger.warn(
          `[Overlock] Already in progress — rentalId=${rentalId}, skipping`,
        );
        return { stgUserId: ownerId, stgUnitId: unitId };
      }

      // 둘 다 true면 중단 + 체크박스 리셋
      if (lockRequested && unlockRequested) {
        this.logger.warn(
          `[Overlock] Both overlock and remove-overlock requested — rentalId=${rentalId}, resetting`,
        );
        await this.sgApi.updateUnitRental(rentalId, {
          customFields: {
            smartcube_lockUnit: false,
            smartcube_unlockUnit: false,
          },
        });
        return { stgUserId: ownerId, stgUnitId: unitId };
      }

      // 요청 없으면 스킵 (체크박스가 false로 리셋된 경우)
      if (!lockRequested && !unlockRequested) {
        this.logger.log(
          `[Overlock] Lock/unlock checkbox cleared (no action) — rentalId=${rentalId}`,
        );
        return { stgUserId: ownerId, stgUnitId: unitId };
      }

      // 1. STG 상태를 "in progress"로 변경
      await this.sgApi.updateUnitRental(rentalId, {
        customFields: {
          smartcube_lockStatus: RentalUpdatedHandler.OVERLOCK_IN_PROGRESS,
        },
      });

      try {
        const parsed = await getParsed();
        if (!parsed) {
          const reason = `smartcube_id missing or invalid for unit ${unitId} (overlock flow)`;
          this.logger.warn(`unitRental.updated: ${reason}, resetting request`);
          await this.sgApi.updateUnitRental(rentalId, {
            customFields: {
              smartcube_lockStatus: currentStatus ?? '',
              smartcube_lockUnit: false,
              smartcube_unlockUnit: false,
            },
          });
          return { softError: reason, stgUnitId: unitId };
        }
        const { areaCode, showBoxNo, officeCode } = parsed;

        const user = await this.sgApi.getUser(ownerId);
        const userPhone = normalizePhone((user['phone'] as string) ?? '');
        userNameCache = extractUserInfo(user).userName;

        // 2. DB 처리
        const transaction = await this.db.beginTransaction();

        if (lockRequested) {
          try {
            await new sql.Request(transaction)
              .input('areaCode', sql.NVarChar, areaCode)
              .input('showBoxNo', sql.Int, showBoxNo)
              .query(
                `UPDATE tblBoxMaster SET useState = 3, isOverlocked = 1, updateTime = GETDATE() WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo`,
              );
            await setPtiUserEnableAllForGroup(
              transaction,
              areaCode,
              userPhone,
              0,
              ownerId,
            );
            await insertBoxHistorySnapshot(
              transaction,
              areaCode,
              showBoxNo,
              StgEventType.ManualOverlock,
            );
            await transaction.commit();
            this.logger.log(
              `[Overlock] Unit + office gate overlocked — ${areaCode}:${showBoxNo}`,
            );

            // 3. STG 상태 업데이트 + 체크박스 리셋
            await this.sgApi.updateUnitRental(rentalId, {
              customFields: {
                smartcube_lockStatus: RentalUpdatedHandler.OVERLOCK_ACTIVE,
                smartcube_lockUnit: false,
              },
            });
          } catch (err) {
            await safeRollback(transaction);
            throw err;
          }
        } else {
          try {
            await new sql.Request(transaction)
              .input('areaCode', sql.NVarChar, areaCode)
              .input('showBoxNo', sql.Int, showBoxNo)
              .query(
                `UPDATE tblBoxMaster SET useState = 1, isOverlocked = 0, updateTime = GETDATE() WHERE areaCode = @areaCode AND showBoxNo = @showBoxNo`,
              );

            // 같은 그룹 내 다른 오버락 유닛 확인 후 PTI 결정 (unmarkOverdue 와 일관)
            const otherOverlocked = await new sql.Request(transaction)
              .input('areaCode', sql.NVarChar, areaCode)
              .input('stgUserId', sql.NVarChar, ownerId)
              .input('userPhone', sql.NVarChar, userPhone)
              .input('showBoxNo', sql.Int, showBoxNo)
              .query<{ cnt: number }>(
                `SELECT COUNT(*) AS cnt FROM tblBoxMaster
                 WHERE areaCode = @areaCode
                   AND userCode = @stgUserId
                   AND isOverlocked = 1
                   AND showBoxNo <> @showBoxNo`,
              );
            const otherCount = otherOverlocked.recordset[0]?.cnt ?? 0;

            if (otherCount === 0) {
              await setPtiUserEnableAllForGroup(
                transaction,
                areaCode,
                userPhone,
                1,
                ownerId,
              );
              this.logger.log(
                `[Overlock] Unit unlocked + group gate opened — ${areaCode}:${showBoxNo}`,
              );
            } else {
              this.logger.log(
                `[Overlock] Unit unlocked but group gate stays blocked (${otherCount} other overlocked unit(s)) — ${areaCode}:${showBoxNo}`,
              );
            }
            await insertBoxHistorySnapshot(
              transaction,
              areaCode,
              showBoxNo,
              StgEventType.ManualUnlock,
            );
            await transaction.commit();
            this.logger.log(
              `[Overlock] Unit + office gate overlock removed — ${areaCode}:${showBoxNo}`,
            );

            // 3. STG 상태 업데이트 + 체크박스 리셋
            await this.sgApi.updateUnitRental(rentalId, {
              customFields: {
                smartcube_lockStatus: RentalUpdatedHandler.OVERLOCK_REMOVED,
                smartcube_unlockUnit: false,
              },
            });
          } catch (err) {
            await safeRollback(transaction);
            throw err;
          }
        }
      } catch (err) {
        this.logger.error(
          `[Overlock] Transaction rolled back: ${(err as Error).message}`,
        );
        // 에러 시 STG 상태 복원 + 체크박스 리셋
        await this.sgApi.updateUnitRental(rentalId, {
          customFields: {
            smartcube_lockStatus: currentStatus ?? '',
            smartcube_lockUnit: false,
            smartcube_unlockUnit: false,
          },
        });
        throw err;
      }
    }

    // -------------------------------------------------------------------------
    // 보류: accessCode 직접 변경 (추후 논의 후 활성화 예정)
    // -------------------------------------------------------------------------
    if (changedKeys.includes('customFields.gate_code')) {
      this.logger.log(
        `[DEFERRED] gate_code changed for rental ${rentalId} — handler deferred per Q18`,
      );
    }

    const parsed = await getParsed();
    if (!parsed) {
      const reason = `smartcube_id missing or invalid for unit ${unitId}`;
      this.logger.warn(`unitRental.updated: ${reason}, skipping`);
      return { softError: reason, stgUnitId: unitId };
    }
    const { areaCode, showBoxNo } = parsed;
    const userName = await getUserName();
    return {
      areaCode,
      showBoxNo,
      userName,
      stgUserId: ownerId,
      stgUnitId: unitId,
    };
  }
}
