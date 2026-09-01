import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';
import { ALLOWED_MIME_TYPES } from './create-document.dto';

/**
 * Same shape as UploadPodDocumentDto — entityType is always 'STOP',
 * entityId comes from the :sequence route param resolved to a Stop id, and
 * documentTypeId is always the seeded POP type, all pre-filled by
 * PopDocumentsController (this route is strictly POP-only, never a
 * general document upload — mirrors PodDocumentsController exactly).
 */
export class UploadPopDocumentDto {
  @IsString()
  @MinLength(1)
  fileName!: string;

  @IsIn(ALLOWED_MIME_TYPES)
  mimeType!: string;

  @IsInt()
  @Min(1)
  fileSizeBytes!: number;

  /** Set when replacing an existing POP for the same stop. */
  @IsOptional()
  @IsUUID()
  existingDocumentFamilyId?: string;
}
