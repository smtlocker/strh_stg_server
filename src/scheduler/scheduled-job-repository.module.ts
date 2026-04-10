import { Global, Module } from '@nestjs/common';
import { ScheduledJobRepository } from './scheduled-job.repository';

/**
 * ScheduledJobRepository 전용 @Global 모듈.
 *
 * MonitoringModule과 SchedulerModule 간의 순환 의존성을 피하기 위해
 * repository를 별도 @Global 모듈로 분리한다.
 *
 * - SchedulerModule → MonitoringModule (SyncLogService 사용)
 * - MonitoringModule → handlers (MoveIn/MoveOutHandler) → ScheduledJobRepository
 *
 * repository를 @Global로 올리면 MonitoringModule이 SchedulerModule을 import하지 않고도
 * handlers가 repository를 주입받을 수 있다.
 */
@Global()
@Module({
  providers: [ScheduledJobRepository],
  exports: [ScheduledJobRepository],
})
export class ScheduledJobRepositoryModule {}
