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
import {
  ApiTags,
  ApiCookieAuth,
  ApiOperation,
  ApiQuery,
  ApiBody,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';
import { SyncLogService } from './sync-log.service';
import { SiteSyncService } from './site-sync.service';
import { StgUnitsCacheService } from './stg-units-cache.service';
import { UserSyncService } from './user-sync.service';
import { ReprocessService } from './reprocess.service';
import { renderDashboardHtml } from './dashboard.html';
import { StoreganiseApiService } from '../storeganise/storeganise-api.service';
import { UnitSyncHandler } from '../handlers/unit-sync.handler';
import { MonitoringAuthService } from './monitoring-auth.service';
import { FailureAlertService } from './failure-alert.service';
import { StartSiteSyncDto } from './dto/start-site-sync.dto';
import { StopJobDto } from './dto/stop-job.dto';
import { TestRetryDto } from './dto/test-retry.dto';
import { TestEmailDto } from './dto/test-email.dto';

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

// ─── Response schemas (Swagger) ──────────────────────────────────────────
const SYNC_LOG_ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    source: {
      type: 'string',
      enum: ['webhook', 'scheduler', 'site-sync', 'user-sync'],
    },
    eventType: { type: 'string' },
    eventId: { type: 'string', nullable: true },
    correlationKey: { type: 'string', nullable: true },
    businessCode: { type: 'string', nullable: true },
    areaCode: { type: 'string', nullable: true },
    showBoxNo: { type: 'integer', nullable: true },
    userName: { type: 'string', nullable: true },
    stgUserId: { type: 'string', nullable: true },
    stgUnitId: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['success', 'error'] },
    attempt: { type: 'integer', nullable: true },
    maxAttempts: { type: 'integer', nullable: true },
    durationMs: { type: 'integer' },
    error: { type: 'string', nullable: true },
    payload: { type: 'object', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    replayedFromLogId: { type: 'integer', nullable: true },
    alertSentAt: { type: 'string', format: 'date-time', nullable: true },
    alertStatus: { type: 'string', nullable: true },
    replayable: { type: 'boolean' },
    replayReason: { type: 'string', nullable: true },
  },
};

const DASHBOARD_STATS_SCHEMA = {
  type: 'object',
  properties: {
    lastEventAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description: '마지막으로 기록된 syncLog 시각 (없으면 null)',
    },
  },
};

const PENDING_JOB_SCHEMA = {
  type: 'object',
  properties: {
    jobId: { type: 'integer' },
    eventType: { type: 'string', example: 'moveIn.activate' },
    type: {
      type: 'string',
      enum: ['moveIn', 'moveOut'],
      description: '대시보드 분류용 상위 카테고리',
    },
    status: { type: 'string', example: 'pending' },
    areaCode: { type: 'string' },
    showBoxNo: { type: 'integer' },
    userName: { type: 'string' },
    userPhone: { type: 'string' },
    stgUserId: { type: 'string' },
    stgUnitId: { type: 'string' },
    scheduledDate: { type: 'string', format: 'date-time', nullable: true },
    attempts: { type: 'integer' },
    maxAttempts: { type: 'integer' },
    sourceEventType: { type: 'string', nullable: true },
    sourceEventId: { type: 'string', nullable: true },
    correlationKey: { type: 'string', nullable: true },
  },
};

const UNIT_GRID_GROUP_SCHEMA = {
  type: 'object',
  properties: {
    groupCode: { type: 'string', example: '0001' },
    units: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          showBoxNo: { type: 'integer' },
          showBoxNoDisp: { type: 'string', nullable: true },
          useState: { type: 'integer', description: '0: 비어있음, 1: 사용중, 3: 퇴거예약' },
          isOverlocked: { type: 'integer', description: '0 or 1' },
          userName: { type: 'string' },
          userPhone: { type: 'string' },
        },
      },
    },
  },
};

const SITE_SYNC_EVENT_DESCRIPTION =
  'SSE `data` 는 JSON string. `type` ∈ `unit-success` / `unit-error` / `unit-retry` / `progress` / `complete` / `stopped` / `error`. ' +
  '`unit-*` 는 `areaCode`/`showBoxNo`/`durationMs` 포함, `progress` 는 `done`/`total`, `complete`/`stopped` 는 집계 통계.';

const TAG_DASHBOARD = 'monitoring/dashboard';
const TAG_SYNC = 'monitoring/sync';
const TAG_GRID = 'monitoring/grid';
const TAG_DEBUG = 'monitoring/debug';

// 태그는 endpoint 별로 method-level 에서 지정 (dashboard/sync/grid/debug).
@ApiCookieAuth('monitoring-session')
@Controller('monitoring')
export class MonitoringController {
  constructor(
    private readonly syncLog: SyncLogService,
    private readonly siteSync: SiteSyncService,
    private readonly userSync: UserSyncService,
    private readonly reprocess: ReprocessService,
    private readonly monitoringAuth: MonitoringAuthService,
    private readonly failureAlert: FailureAlertService,
    private readonly stgUnitsCache: StgUnitsCacheService,
  ) {}

  @ApiTags(TAG_DASHBOARD)
  @Get()
  @Header('Content-Type', 'text/html')
  @Header('Cache-Control', 'no-cache, no-store, must-revalidate')
  @ApiOperation({
    summary: '대시보드 HTML',
    description: '운영자용 모니터링 대시보드 페이지를 반환한다 (서버사이드 렌더링).',
  })
  @ApiResponse({ status: 200, description: '대시보드 HTML' })
  getDashboard(@Req() req: Request): string {
    const mgrId = this.monitoringAuth.getSessionFromRequest(req)?.mgrId ?? '-';
    return renderDashboardHtml(mgrId);
  }

  @ApiTags(TAG_DASHBOARD)
  @Get('api/stats')
  @ApiOperation({
    summary: '대시보드 헤더 통계',
    description: '마지막 이벤트 시각 등 헤더에 표시할 글로벌 카운터를 반환한다.',
  })
  @ApiResponse({ status: 200, schema: DASHBOARD_STATS_SCHEMA })
  getStats() {
    return this.syncLog.getStats();
  }

  @ApiTags(TAG_DASHBOARD)
  @Get('api/logs')
  @ApiOperation({
    summary: 'sync 로그 조회 (페이지네이션/필터)',
    description:
      'tblSyncLog 에 기록된 sync 이벤트(웹훅·스케줄러·site-sync·user-sync) 를 조회. 모든 쿼리 파라미터는 optional 이며 누적 적용된다.',
  })
  @ApiQuery({ name: 'limit', required: false, description: '페이지 크기 (기본 50)' })
  @ApiQuery({ name: 'offset', required: false, description: '시작 오프셋 (기본 0)' })
  @ApiQuery({
    name: 'sources',
    required: false,
    description: 'comma-separated source 필터 (`webhook,scheduler,site-sync,user-sync`)',
  })
  @ApiQuery({ name: 'status', required: false, description: '`success` 또는 `error`' })
  @ApiQuery({ name: 'q', required: false, description: '검색어 (free text)' })
  @ApiQuery({
    name: 'searchFields',
    required: false,
    description: 'comma-separated 검색 대상 컬럼',
  })
  @ApiQuery({ name: 'site', required: false, description: 'businessCode (지점) 필터' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: SYNC_LOG_ENTRY_SCHEMA },
        total: { type: 'integer', description: '필터 적용 후 전체 건수' },
      },
    },
  })
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

  @ApiTags(TAG_DASHBOARD)
  @Get('api/pending')
  @ApiOperation({
    summary: '대기 중 스케줄 작업 조회',
    description:
      'tblScheduledJob 에서 status=`pending`(또는 in-progress) 인 작업 목록을 반환. 대시보드 우측 패널 표시용.',
  })
  @ApiResponse({
    status: 200,
    schema: { type: 'array', items: PENDING_JOB_SCHEMA },
  })
  async getPending() {
    const pending = await this.syncLog.getPendingScheduled();
    return pending.map((e) => ({
      ...e,
      scheduledDate: e.scheduledDate ? toIsoUtc(e.scheduledDate) : null,
    }));
  }

  @ApiTags(TAG_DASHBOARD)
  @Get('api/errors')
  @ApiOperation({
    summary: '실패한 sync 로그 조회',
    description: '`status=error` 로 종결된 로그를 최신순으로 반환. 재처리 버튼 노출용.',
  })
  @ApiQuery({ name: 'limit', required: false, description: '최근 N건 (기본 20)' })
  @ApiResponse({
    status: 200,
    schema: { type: 'array', items: SYNC_LOG_ENTRY_SCHEMA },
  })
  async getErrors(@Query('limit') limit?: string) {
    const errors = await this.syncLog.getErrors(
      limit ? parseInt(limit, 10) : 20,
    );
    return convertDates(errors);
  }

  @ApiTags(TAG_DASHBOARD)
  @Post('api/errors/:id/reprocess')
  @ApiOperation({
    summary: '실패 로그 재처리',
    description:
      '특정 syncLog id 를 골라 원래 핸들러를 다시 호출한다. 결과는 새로운 syncLog 로 기록된다.',
  })
  @ApiParam({ name: 'id', description: 'tblSyncLog.id', example: 12345 })
  @ApiResponse({
    status: 201,
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        replayedLogId: { type: 'integer', nullable: true },
        reason: { type: 'string', nullable: true, description: '실패 사유 (ok:false 일 때)' },
      },
    },
  })
  async reprocessError(@Param('id') id: string) {
    return this.reprocess.reprocess(parseInt(id, 10));
  }

  @ApiTags(TAG_GRID)
  @Get('api/groups')
  @ApiOperation({
    summary: '지점 내 그룹 목록',
    description: '`officeCode` 가 지정되지 않으면 빈 배열 반환.',
  })
  @ApiQuery({ name: 'officeCode', required: true, description: '지점 코드 (예: `001`)' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          groupCode: { type: 'string', example: '0001' },
          unitCount: { type: 'integer' },
        },
      },
    },
  })
  async getGroups(@Query('officeCode') officeCode: string) {
    if (!officeCode) return [];
    return this.syncLog.getGroupsByOffice(officeCode);
  }

  @ApiTags(TAG_GRID)
  @Get('api/units')
  @ApiOperation({
    summary: '특정 그룹의 유닛 목록 (호호락 DB 단일 그룹)',
    description: '대시보드 그룹 클릭 시 사용. `officeCode + groupCode` 둘 다 필수.',
  })
  @ApiQuery({ name: 'officeCode', required: true })
  @ApiQuery({ name: 'groupCode', required: true })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          showBoxNo: { type: 'integer' },
          userName: { type: 'string' },
          userPhone: { type: 'string' },
          useState: { type: 'integer' },
        },
      },
    },
  })
  async getUnits(
    @Query('officeCode') officeCode: string,
    @Query('groupCode') groupCode: string,
  ) {
    if (!officeCode || !groupCode) return [];
    return this.syncLog.getUnitsByGroup(officeCode, groupCode);
  }

  @ApiTags(TAG_GRID)
  @Get('api/stg-units')
  @ApiOperation({
    summary: '지점 전체 유닛 (STG 기준 그리드)',
    description:
      'STG 유닛 캐시에서 즉답. 캐시는 30분 주기 delta sync (`updatedAfter` cursor) + 매일 새벽 4시 (Asia/Seoul) 풀 스윕 + webhook 이벤트 기반 invalidate (5초 leading-edge debounce per office) 로 유지된다. 캐시 미존재 시에만 on-demand fetch.',
  })
  @ApiQuery({ name: 'officeCode', required: true })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        groups: { type: 'array', items: UNIT_GRID_GROUP_SCHEMA },
        fetchedAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  })
  async getStgUnits(@Query('officeCode') officeCode: string) {
    if (!officeCode) return { groups: [], fetchedAt: null };
    const entry = await this.stgUnitsCache.getOrFetch(officeCode);
    return { ...entry.data, fetchedAt: entry.fetchedAt.toISOString() };
  }

  @ApiTags(TAG_GRID)
  @Post('api/stg-units/refresh')
  @ApiOperation({
    summary: 'STG 유닛 캐시 강제 새로고침 (현재 지점)',
    description:
      '주어진 officeCode 에 대해 STG 에서 즉시 재조회 후 캐시 갱신. 응답으로 갱신된 데이터 + fetchedAt 반환.',
  })
  @ApiQuery({ name: 'officeCode', required: true })
  @ApiResponse({
    status: 201,
    schema: {
      type: 'object',
      properties: {
        groups: { type: 'array', items: UNIT_GRID_GROUP_SCHEMA },
        fetchedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  async refreshStgUnits(@Query('officeCode') officeCode: string) {
    if (!officeCode) return { groups: [], fetchedAt: null };
    const entry = await this.stgUnitsCache.refresh(officeCode);
    return { ...entry.data, fetchedAt: entry.fetchedAt.toISOString() };
  }

  @ApiTags(TAG_GRID)
  @Get('api/db-units')
  @ApiOperation({
    summary: '지점 전체 유닛 (호호락 DB 기준 그리드)',
    description:
      'tblBoxMaster 에서 `strh{office}*` 전체 행을 그룹별로 반환. 대시보드 [호호락] 토글 뷰 (기본).',
  })
  @ApiQuery({ name: 'officeCode', required: true })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        groups: { type: 'array', items: UNIT_GRID_GROUP_SCHEMA },
      },
    },
  })
  async getDbUnits(@Query('officeCode') officeCode: string) {
    if (!officeCode) return { groups: [] };
    return this.siteSync.getDbUnits(officeCode);
  }

  @ApiTags(TAG_SYNC)
  @Post('api/site-sync')
  @ApiOperation({
    summary: '지점 동기화 시작',
    description:
      '전체 그룹 또는 지정한 그룹/유닛만 STG ↔ DB sync. 백그라운드 job 으로 실행되며 jobId 반환. SSE `/api/site-sync/stream` 으로 진행 구독.',
  })
  @ApiBody({ type: StartSiteSyncDto })
  @ApiResponse({
    status: 201,
    schema: {
      oneOf: [
        {
          type: 'object',
          properties: { jobId: { type: 'string', example: 'site-sync-001-abc' } },
        },
        {
          type: 'object',
          properties: { error: { type: 'string', example: 'officeCode is required' } },
        },
      ],
    },
  })
  startSiteSync(@Body() body: StartSiteSyncDto) {
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

  @ApiTags(TAG_SYNC)
  @Post('api/site-sync/stop')
  @ApiOperation({
    summary: '지점 동기화 중지 요청',
    description: '실행 중인 jobId 의 다음 유닛부터 중지. 진행 중인 유닛은 완료 후 종료.',
  })
  @ApiBody({ type: StopJobDto })
  @ApiResponse({
    status: 201,
    schema: {
      type: 'object',
      properties: {
        stopped: {
          type: 'boolean',
          description: 'true = 중지 신호 전달, false = jobId 없음',
        },
      },
    },
  })
  stopSiteSync(@Body() body: StopJobDto) {
    const stopped = this.siteSync.stopSync(body.jobId);
    return { stopped };
  }

  @ApiTags(TAG_SYNC)
  @Sse('api/site-sync/stream')
  @ApiOperation({
    summary: '지점 동기화 진행 SSE',
    description:
      'jobId 의 진행 이벤트 (`unit-success`/`unit-error`/`unit-retry`/`progress`/`complete`/`stopped`) 를 Server-Sent Events 로 스트림. ' +
      SITE_SYNC_EVENT_DESCRIPTION,
  })
  @ApiQuery({ name: 'jobId', required: true })
  @ApiResponse({
    status: 200,
    description: 'text/event-stream. `data: <json>` 라인 반복',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
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

  @ApiTags(TAG_SYNC)
  @Post('api/user-sync')
  @ApiOperation({
    summary: '사용자 동기화 시작',
    description: 'STG 사용자 정보를 DB tblPTIUserInfo / tblBoxMaster 에 phone+name 매칭으로 동기화. 동시에 1개 job 만 실행 가능.',
  })
  @ApiResponse({
    status: 201,
    schema: {
      oneOf: [
        { type: 'object', properties: { jobId: { type: 'string' } } },
        {
          type: 'object',
          properties: { error: { type: 'string', example: 'User sync is already running' } },
        },
      ],
    },
  })
  startUserSync() {
    if (this.userSync.isRunning()) {
      return { error: 'User sync is already running' };
    }
    const jobId = this.userSync.startSync();
    return { jobId };
  }

  @ApiTags(TAG_SYNC)
  @Post('api/user-sync/stop')
  @ApiOperation({ summary: '사용자 동기화 중지 요청' })
  @ApiBody({ type: StopJobDto })
  @ApiResponse({
    status: 201,
    schema: {
      type: 'object',
      properties: { stopped: { type: 'boolean' } },
    },
  })
  stopUserSync(@Body() body: StopJobDto) {
    const stopped = this.userSync.stopSync(body.jobId);
    return { stopped };
  }

  @ApiTags(TAG_SYNC)
  @Sse('api/user-sync/stream')
  @ApiOperation({
    summary: '사용자 동기화 진행 SSE',
    description: 'user-sync job 의 진행 이벤트 스트림.',
  })
  @ApiQuery({ name: 'jobId', required: true })
  @ApiResponse({
    status: 200,
    description: 'text/event-stream. SSE data 는 site-sync stream 과 동일 구조.',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
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

  @ApiTags(TAG_DASHBOARD)
  @Sse('api/stream')
  @ApiOperation({
    summary: '대시보드 실시간 sync log SSE',
    description:
      '새로운 syncLog 이벤트가 발생할 때마다 push. 대시보드 좌측 피드 실시간 갱신용. 각 `data:` 는 SyncLogEntry JSON.',
  })
  @ApiResponse({
    status: 200,
    description: 'text/event-stream. `data:` 에 SyncLogEntry JSON',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
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
  @ApiTags(TAG_DEBUG)
  @Post('api/test-retry')
  @ApiOperation({
    summary: '[DEBUG] 강제 실패 카운터 설정',
    description:
      '지정한 컴포넌트(`stg-api`/`unit-sync`/`site-sync`/`all`) 의 다음 N회 호출을 강제 실패시켜 retry/backoff 동작을 검증한다. 운영 환경에선 사용 금지.',
  })
  @ApiBody({ type: TestRetryDto })
  @ApiResponse({
    status: 201,
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        targets: {
          type: 'object',
          additionalProperties: { type: 'integer' },
          example: { 'stg-api': 2, 'unit-sync': 2 },
        },
      },
    },
  })
  setRetryDebug(@Body() body: TestRetryDto) {
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

  @ApiTags(TAG_DEBUG)
  @Get('api/test-retry/status')
  @ApiOperation({
    summary: '[DEBUG] 강제 실패 카운터 현재 값',
    description: '각 컴포넌트의 남은 강제 실패 횟수를 조회.',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        'stg-api': { type: 'integer' },
        'unit-sync': { type: 'integer' },
        'site-sync': { type: 'integer' },
      },
    },
  })
  getRetryDebugStatus() {
    return {
      'stg-api': StoreganiseApiService.__debugFailCount,
      'unit-sync': UnitSyncHandler.__debugFailCount,
      'site-sync': SiteSyncService.__debugFailCount,
    };
  }

  @ApiTags(TAG_DEBUG)
  @Post('api/test-retry/reset')
  @ApiOperation({
    summary: '[DEBUG] 강제 실패 카운터 초기화',
    description: '모든 컴포넌트의 강제 실패 카운터를 0 으로 리셋.',
  })
  @ApiResponse({
    status: 201,
    schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
    },
  })
  resetRetryDebug() {
    StoreganiseApiService.__debugFailCount = 0;
    UnitSyncHandler.__debugFailCount = 0;
    SiteSyncService.__debugFailCount = 0;
    return { message: 'DEBUG: 모든 강제 실패 카운터 초기화 완료' };
  }

  @ApiTags(TAG_DEBUG)
  @Get('api/test-email/config')
  @ApiOperation({
    summary: '메일 발송 SMTP 설정 조회',
    description:
      '대시보드 메일 테스트 패널 표시용. SMTP 호스트/포트/From 주소와 transporter 초기화 상태를 반환 (비밀번호 제외).',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        port: { type: 'integer' },
        from: { type: 'string' },
        transporterReady: { type: 'boolean' },
      },
    },
  })
  getTestEmailConfig() {
    return this.failureAlert.getSmtpInfo();
  }

  @ApiTags(TAG_DEBUG)
  @Post('api/test-email')
  @ApiOperation({
    summary: '메일 발송 테스트',
    description:
      '실제 알람 메일과 동일한 transporter 인스턴스로 테스트 메일 1통 발송. 결과는 `{ ok, messageId? } | { ok: false, error }`.',
  })
  @ApiBody({ type: TestEmailDto })
  @ApiResponse({
    status: 201,
    schema: {
      oneOf: [
        {
          type: 'object',
          properties: {
            ok: { type: 'boolean', enum: [true] },
            messageId: { type: 'string' },
          },
        },
        {
          type: 'object',
          properties: {
            ok: { type: 'boolean', enum: [false] },
            error: { type: 'string' },
          },
        },
      ],
    },
  })
  async sendTestEmail(@Body() body: TestEmailDto) {
    return this.failureAlert.sendTestEmail(
      body.to,
      body.subject ?? '',
      body.body ?? '',
    );
  }
}
