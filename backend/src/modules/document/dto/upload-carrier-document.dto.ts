import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';
import { ALLOWED_MIME_TYPES } from './create-document.dto';

/**
 * Same shape as CreateDocumentDto minus entityType/entityId (pre-filled
 * from the :carrierId route param by CarrierDocumentsController) — kept
 * as a real class rather than a TypeScript `Omit<>` alias, since
 * NestJS's ValidationPipe needs an actual class reference (via
 * reflect-metadata) to instantiate and validate against; a mapped type
 * has no runtime representation.
 */
export class UploadCarrierDocumentDto {
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

  @IsOptional()
  @IsUUID()
  existingDocumentFamilyId?: string;
}
