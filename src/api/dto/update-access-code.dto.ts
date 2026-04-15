import { IsString, IsNotEmpty, Matches, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateAccessCodeDto {
  @ApiProperty({
    description: 'STG `ownerId` — 대상 고객의 Storeganise user id',
    example: '6a8b1c2d3e4f5060718293a4',
  })
  @IsString()
  @IsNotEmpty()
  stgUserId: string;

  @ApiProperty({
    description:
      '지점 코드. 4자리 포맷(`site customFields.smartcube_siteCode`) 권장. 3자리 legacy 입력도 허용.',
    example: '0002',
    pattern: '^\\d{3,4}$',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{3,4}$/, {
    message: 'officeCode must be 3-4 digits (e.g. "0001" or "001")',
  })
  officeCode: string;

  @ApiProperty({
    description: '새 게이트 PIN — 숫자 4~8자리',
    example: '123456',
    minLength: 4,
    maxLength: 8,
    pattern: '^\\d+$',
  })
  @IsString()
  @IsNotEmpty()
  @Length(4, 8)
  @Matches(/^\d+$/, { message: 'accessCode must be numeric' })
  accessCode: string;
}
