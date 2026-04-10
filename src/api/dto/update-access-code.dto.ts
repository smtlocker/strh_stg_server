import { IsString, IsNotEmpty, Matches, Length } from 'class-validator';

export class UpdateAccessCodeDto {
  @IsString()
  @IsNotEmpty()
  stgUserId: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{3,4}$/, {
    message: 'officeCode must be 3-4 digits (e.g. "001")',
  })
  officeCode: string;

  @IsString()
  @IsNotEmpty()
  @Length(4, 8)
  @Matches(/^\d+$/, { message: 'accessCode must be numeric' })
  accessCode: string;
}
