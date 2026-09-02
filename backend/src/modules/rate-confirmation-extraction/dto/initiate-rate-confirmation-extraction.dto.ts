import { IsIn, IsInt, IsString, Max, Min, MinLength } from 'class-validator';

/** PDF only. Extraction is 100% local and text-layer-based (no AI, no OCR) — scanned/image-only PDFs are rejected with a clear error at extraction time (see NO_TEXT_LAYER_ERROR_MESSAGE), not accepted as a raw image upload. */
export const ALLOWED_RATE_CONFIRMATION_MIME_TYPES = ['application/pdf'] as const;

/** 20 MB — matches the approved design's file-size cap for a rate confirmation PDF. */
export const MAX_RATE_CONFIRMATION_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export class InitiateRateConfirmationExtractionDto {
  @IsString()
  @MinLength(1)
  fileName!: string;

  @IsIn(ALLOWED_RATE_CONFIRMATION_MIME_TYPES)
  mimeType!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_RATE_CONFIRMATION_FILE_SIZE_BYTES, {
    message: 'fileSizeBytes must not exceed 20 MB.',
  })
  fileSizeBytes!: number;
}
