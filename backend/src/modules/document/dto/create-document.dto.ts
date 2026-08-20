import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
} from 'class-validator';
import { DocumentEntityType } from '@prisma/client';

/** Restricted to PDF/JPG/JPEG/PNG in V1 (DATABASE_DESIGN.md §7). */
export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

export class CreateDocumentDto {
  @IsIn([
    'LOAD',
    'STOP',
    'CUSTOMER',
    'CARRIER',
    'DRIVER',
    'TRUCK',
    'TRAILER',
    'INVOICE',
    'CARRIER_PAYMENT',
  ])
  entityType!: DocumentEntityType;

  @IsUUID()
  entityId!: string;

  @IsUUID()
  documentTypeId!: string;

  @IsOptional()
  @IsString()
  customTypeLabel?: string;

  @IsString()
  @MinLength(1)
  fileName!: string;

  @IsIn(ALLOWED_MIME_TYPES)
  mimeType!: string;

  @IsInt()
  @Min(1)
  fileSizeBytes!: number;

  /**
   * Set only when uploading a new version of an existing document family
   * (DATABASE_DESIGN.md §7/Decision Log D4) — omit for a brand-new
   * document.
   */
  @IsOptional()
  @IsUUID()
  existingDocumentFamilyId?: string;

  /**
   * Phase 7 addition — Workflow 3 §3.9's compliance expiration sweep needs
   * this on document types that carry one (e.g. MC Authority, Carrier
   * Agreement). Optional and meaningless for document types with no
   * applicable expiration date — the sweep only acts on document types it
   * already knows carry one, per the same hardcoded compliance-code list
   * `CarrierEligibilityService` already uses.
   */
  @IsOptional()
  @IsDateString()
  expirationDate?: string;
}
