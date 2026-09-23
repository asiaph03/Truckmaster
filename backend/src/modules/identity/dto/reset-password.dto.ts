import { IsString, MinLength } from 'class-validator';

/**
 * Phase 6B — `POST /auth/reset-password`. `password` is presence-checked
 * only here, mirroring ActivateMembershipDto's own convention — actual
 * complexity rules (length, letter+number) live exclusively in
 * PasswordService.assertValid, the single source of truth (locked
 * decision — do not duplicate password validation rules).
 */
export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
