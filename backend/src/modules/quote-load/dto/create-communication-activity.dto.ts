import { IsDateString, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { CommunicationDirection } from '@prisma/client';

/**
 * Frontend Phase 7 (Activity History, UI_UX_DESIGN.md §5.4.4). activityType
 * is free text (PRD.md's own example values: "Called Carrier", "Sent Rate
 * Confirmation"), mirroring LogCheckCallDto.contactMethod rather than a
 * fixed enum. direction is always optional — no conditional-required rule
 * (approved scope decision; direction has no locked-doc precedent at all).
 */
export class CreateCommunicationActivityDto {
  @IsString()
  @MinLength(1)
  activityType!: string;

  @IsOptional()
  @IsEnum(CommunicationDirection)
  direction?: CommunicationDirection;

  @IsOptional()
  @IsString()
  contactPerson?: string;

  @IsString()
  @MinLength(1)
  notes!: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;
}
