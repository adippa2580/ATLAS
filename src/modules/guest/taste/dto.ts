import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
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

  // Bound the weight so a caller can't inject a huge value to poison the graph.
  @IsOptional()
  @IsNumber()
  @Min(-10)
  @Max(10)
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
