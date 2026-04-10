import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Sse,
  Header,
  MessageEvent,
  Param,
  Req,

} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';
import { SyncLogService } from './sync-log.service';
import { SiteSyncService } from './site-sync.service';
import { UserSyncService } from './user-sync.service';
import { ReprocessService } from './reprocess.service';
import { renderDashboardHtml } from './dashboard.html';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { UnitSyncHandler } from '../handlers/unit-sync.handler';
import { MonitoringAuthService } from './monitoring-auth.service';

/**
 * DatabaseService의 useUTC:false 설정으로 mssql 드라이버가 이미 KST wall clock을
 * 올바른 UTC instant로 변환한다. 따라서 정상 ISO(Z 포함)를 그대로 보내면
 * 브라우저의 Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul'})가 KST로 표시.
 * (과거 useUTC:true 시절에는 'Z'→'+09:00' 치환으로 이중 변환 hack을 썼으나
 * useUTC:false 전환 후에는 불필요 + 버그 유발이라 제거함.)
 */
function toIsoUtc(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toISOString();
}

type EntryWithCreatedAt = { createdAt?: Date | string | null };

function convertDates<T extends EntryWithCreatedAt>(entries: T[]): T[] {
  return entries.map((e) => ({
    ...e,
    createdAt: e.createdAt ? toIsoUtc(e.createdAt) : e.createdAt,
  })) as T[];
}

@Controller('monitoring')
export class MonitoringController {
  constructor(
    private readonly syncLog: SyncLogService,
    private readonly siteSync: SiteSyncService,
    private readonly userSync: UserSyncService,
    private readonly reprocess: ReprocessService,
    private readonly monitoringAuth: MonitoringAuthService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/html')
  @Header('Cache-Control', 'no-cache, no-store, must-revalidate')
  getDashboard(@Req() req: Request): string {
    const mgrId = this.monitoringAuth.getSessionFromRequest(req)?.mgrId ?? '-';
    return renderDashboardHtml(mgrId);
  }

  @Get('api/stats')
  getStats() {
    return this.syncLog.getStats();
  }

  @Get('api/logs')
  async getLogs(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('sources') sources?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('searchFields') searchFields?: string,
    @Query('site') site?: string,
  ) {
    const result = await this.syncLog.getAll(
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
      sources
        ? sources
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : undefined,
      status,
      q,
      searchFields
        ? searchFields
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : undefined,
      site,
    );
    return {
      items: convertDates(result.items),
      total: result.total,
    };
  }

  @Get('api/pending')
  async getPending() {
    const pending = await this.syncLog.getPendingScheduled();
    return pending.map((e) => ({
      ...e,
      scheduledDate: e.scheduledDate ? toIsoUtc(e.scheduledDate) : null,
    }));
  }

  @Get('api/errors')
  async getErrors(@Query('limit') limit?: string) {
    const errors = await this.syncLog.getErrors(
      limit ? parseInt(limit, 10) : 20,
    );
    return convertDates(errors);
  }

  @Post('api/errors/:id/reprocess')

  async reprocessError(@Param('id') id: string) {
    return this.reprocess.reprocess(parseInt(id, 10));
  }

  @Get('api/groups')
  async getGroups(@Query('officeCode') officeCode: string) {
    if (!officeCode) return [];
    return this.syncLog.getGroupsByOffice(officeCode);
  }

  @Get('api/units')
  async getUnits(
    @Query('officeCode') officeCode: string,
    @Query('groupCode') groupCode: string,
  ) {
    if (!officeCode || !groupCode) return [];
    return this.syncLog.getUnitsByGroup(officeCode, groupCode);
  }

  @Get('api/stg-units')
  async getStgUnits(@Query('officeCode') officeCode: string) {
    if (!officeCode) return { groups: [] };
    return this.siteSync.getStgUnits(officeCode);
  }

  @Post('api/site-sync')

  startSiteSync(
    @Body()
    body: {
      officeCode: string;
      groupCodes?: string[];
      unitFilter?: { groupCode: string; showBoxNos: number[] };
      unitFilters?: { groupCode: string; showBoxNos: number[] }[];
    },
  ) {
    const { officeCode, groupCodes, unitFilter, unitFilters } = body;
    if (!officeCode) return { error: 'officeCode is required' };
    if (this.siteSync.isRunning(officeCode)) {
      return { error: `Site sync already running for office ${officeCode}` };
    }
    const jobId = this.siteSync.startSync(
      officeCode,
      groupCodes,
      unitFilter,
      unitFilters,
    );
    return { jobId };
  }

  @Post('api/site-sync/stop')

  stopSiteSync(@Body() body: { jobId: string }) {
    const stopped = this.siteSync.stopSync(body.jobId);
    return { stopped };
  }

  @Sse('api/site-sync/stream')
  siteSyncStream(@Query('jobId') jobId: string): Observable<MessageEvent> {
    const stream = this.siteSync.getJobStream(jobId);
    if (!stream) {
      return new Observable((sub) => {
        sub.next({
          data: JSON.stringify({ type: 'error', error: 'Job not found' }),
        } as MessageEvent);
        sub.complete();
      });
    }
    return stream.pipe(
      map((event) => ({ data: JSON.stringify(event) }) as MessageEvent),
    );
  }

  @Post('api/user-sync')

  startUserSync() {
    if (this.userSync.isRunning()) {
      return { error: 'User sync is already running' };
    }
    const jobId = this.userSync.startSync();
    return { jobId };
  }

  @Post('api/user-sync/stop')

  stopUserSync(@Body() body: { jobId: string }) {
    const stopped = this.userSync.stopSync(body.jobId);
    return { stopped };
  }

  @Sse('api/user-sync/stream')
  userSyncStream(@Query('jobId') jobId: string): Observable<MessageEvent> {
    const stream = this.userSync.getJobStream(jobId);
    if (!stream) {
      return new Observable((sub) => {
        sub.next({
          data: JSON.stringify({ type: 'error', error: 'Job not found' }),
        } as MessageEvent);
        sub.complete();
      });
    }
    return stream.pipe(
      map((event) => ({ data: JSON.stringify(event) }) as MessageEvent),
    );
  }

  @Sse('api/stream')
  stream(): Observable<MessageEvent> {
    return this.syncLog.events$.pipe(
      map(
        (entry) =>
          ({
            data: JSON.stringify({
              ...entry,
              createdAt: entry.createdAt
                ? toIsoUtc(entry.createdAt)
                : entry.createdAt,
            }),
          }) as MessageEvent,
      ),
    );
  }

  // ─── DEBUG: 재시도 로직 수동 테스트 ────────────────────────────
  @Post('api/test-retry')

  setRetryDebug(
    @Body()
    body: {
      target: 'stg-api' | 'unit-sync' | 'site-sync' | 'all';
      failCount?: number;
    },
  ) {
    const count = body.failCount ?? 2;
    const results: Record<string, number> = {};

    if (body.target === 'stg-api' || body.target === 'all') {
      StoreganiseApiService.__debugFailCount = count;
      results['stg-api'] = count;
    }
    if (body.target === 'unit-sync' || body.target === 'all') {
      UnitSyncHandler.__debugFailCount = count;
      results['unit-sync'] = count;
    }
    if (body.target === 'site-sync' || body.target === 'all') {
      SiteSyncService.__debugFailCount = count;
      results['site-sync'] = count;
    }

    return {
      message: `DEBUG: 다음 요청부터 ${count}회 강제 실패 후 정상 동작`,
      targets: results,
    };
  }

  @Get('api/test-retry/status')
  getRetryDebugStatus() {
    return {
      'stg-api': StoreganiseApiService.__debugFailCount,
      'unit-sync': UnitSyncHandler.__debugFailCount,
      'site-sync': SiteSyncService.__debugFailCount,
    };
  }

  @Post('api/test-retry/reset')

  resetRetryDebug() {
    StoreganiseApiService.__debugFailCount = 0;
    UnitSyncHandler.__debugFailCount = 0;
    SiteSyncService.__debugFailCount = 0;
    return { message: 'DEBUG: 모든 강제 실패 카운터 초기화 완료' };
  }
}
