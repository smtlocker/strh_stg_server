import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UnitFilterDto {
  @ApiProperty({ example: '0001' })
  @IsString()
  @IsNotEmpty()
  groupCode: string;

  @ApiProperty({ type: [Number], example: [101, 102] })
  @IsArray()
  @IsInt({ each: true })
  showBoxNos: number[];
}

export class StartSiteSyncDto {
  @ApiProperty({ example: '001', description: '지점 코드 (3자리)' })
  @IsString()
  @IsNotEmpty()
  officeCode: string;

  @ApiPropertyOptional({
    type: [String],
    description: '동기화 대상 그룹 화이트리스트. 비우면 전체 그룹',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  groupCodes?: string[];

  @ApiPropertyOptional({ type: UnitFilterDto, description: '단일 그룹 내 특정 유닛만' })
  @IsOptional()
  @ValidateNested()
  @Type(() => UnitFilterDto)
  unitFilter?: UnitFilterDto;

  @ApiPropertyOptional({ type: [UnitFilterDto], description: '여러 그룹의 특정 유닛들' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UnitFilterDto)
  unitFilters?: UnitFilterDto[];
}
