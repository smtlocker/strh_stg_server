import { IsNotEmpty, IsOptional, IsObject, IsString } from 'class-validator';

export class WebhookDataDto {
  [key: string]: unknown;

  jobId?: string;
  unitRentalId?: string;
  unitId?: string;
  userId?: string;
  changedKeys?: string[];
  oldRentalId?: string | Record<string, unknown>;
  newRentalId?: string | Record<string, unknown>;
  newUnitId?: string | Record<string, unknown>;
  oldUnitId?: string | Record<string, unknown>;
  date?: string;
  transferDate?: string;
  price?: number;
}

export class WebhookPayloadDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  type: string;

  @IsString()
  @IsOptional()
  businessCode?: string;

  @IsString()
  @IsOptional()
  apiUrl?: string;

  @IsString()
  @IsOptional()
  created?: string;

  @IsOptional()
  @IsObject()
  data?: WebhookDataDto;
}
