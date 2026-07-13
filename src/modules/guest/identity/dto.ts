import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { IdentityLinkKind } from '@prisma/client';

export class CreateGuestDto {
  @IsOptional()
  @IsString()
  primaryPhone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsBoolean()
  provisional?: boolean;

  @IsOptional()
  @IsString()
  walletPassId?: string;
}

export class AddLinkDto {
  @IsEnum(IdentityLinkKind)
  kind!: IdentityLinkKind;

  /** Raw value (phone/email/fingerprint); stored hashed. */
  @IsString()
  value!: string;

  @IsOptional()
  @IsBoolean()
  verified?: boolean;

  @IsOptional()
  @IsString()
  source?: string;
}

export class MergeDto {
  @IsString()
  survivingId!: string;

  @IsArray()
  @IsString({ each: true })
  absorbedIds!: string[];

  @IsOptional()
  @IsString()
  reason?: string;
}
