import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class StopJobDto {
  @ApiProperty({ description: '중지할 job id', example: 'site-sync-001-abc' })
  @IsString()
  @IsNotEmpty()
  jobId: string;
}
