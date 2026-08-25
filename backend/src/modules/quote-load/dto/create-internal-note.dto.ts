import { IsString, MinLength } from 'class-validator';

/** Frontend Phase 7 (Activity History, UI_UX_DESIGN.md §5.4.4) — content only; timestamp/author are backend-set. */
export class CreateInternalNoteDto {
  @IsString()
  @MinLength(1)
  content!: string;
}
