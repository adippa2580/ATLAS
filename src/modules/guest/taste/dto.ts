import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Provenance, Signal, SubjectType } from '@prisma/client';

export class AppendEvidenceDto {
  @IsString()
  guestId!: string;

  @IsEnum(SubjectType)
  subjectType!: SubjectType;

  @IsString()
  subjectRef!: string;

  @IsEnum(Signal)
  signal!: Signal;

  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;

  @IsEnum(Provenance)
  provenance!: Provenance;

  @IsOptional()
  @IsString()
  consentId?: string;

  /** Stable idempotency key: sha(source, externalId, signal). */
  @IsString()
  dedupeKey!: string;
}

export class MuteDto {
  @IsEnum(SubjectType)
  subjectType!: SubjectType;

  @IsString()
  subjectRef!: string;
}
