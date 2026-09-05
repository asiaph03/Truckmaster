import { IsString, MinLength } from 'class-validator';

/** Cancel Load workflow — cancellation reason is required, never blank. */
export class CancelLoadDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
