import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type RetryDebugTarget = 'stg-api' | 'unit-sync' | 'site-sync' | 'all';

export class TestRetryDto {
  @ApiProperty({
    enum: ['stg-api', 'unit-sync', 'site-sync', 'all'],
    description: '강제 실패 주입 대상 컴포넌트',
  })
  @IsEnum(['stg-api', 'unit-sync', 'site-sync', 'all'])
  target: RetryDebugTarget;

  @ApiPropertyOptional({ description: '강제 실패 횟수 (기본 2)', example: 2 })
  @IsOptional()
  @IsInt()
  @Min(0)
  failCount?: number;
}
