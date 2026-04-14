import { IsEmail, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TestEmailDto {
  @ApiProperty({ description: '수신자 이메일', example: 'ops@example.com' })
  @IsEmail()
  to: string;

  @ApiPropertyOptional({ description: '제목 (비우면 기본 제목)' })
  @IsOptional()
  @IsString()
  subject?: string;

  @ApiPropertyOptional({ description: '본문 텍스트' })
  @IsOptional()
  @IsString()
  body?: string;
}
