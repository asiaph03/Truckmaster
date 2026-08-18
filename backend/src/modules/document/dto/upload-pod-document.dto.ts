import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';
import { ALLOWED_MIME_TYPES } from './create-document.dto';

/**
 * Same shape as CreateDocumentDto minus entityType/entityId/documentTypeId
 * — entityType is always 'STOP', entityId comes from the :sequence route
 * param resolved to a Stop id, and documentTypeId is always the seeded
 * POD type, all pre-filled by PodDocumentsController (Workflow 7 §7.1 is
 * strictly POD-only at this route, never a general document upload).
 */
export class UploadPodDocumentDto {
  @IsString()
  @MinLength(1)
  fileName!: string;

  @IsIn(ALLOWED_MIME_TYPES)
  mimeType!: string;

  @IsInt()
  @Min(1)
  fileSizeBytes!: number;

  /** Workflow 7 §7.3 — set when replacing an existing POD for the same stop. */
  @IsOptional()
  @IsUUID()
  existingDocumentFamilyId?: string;
}
