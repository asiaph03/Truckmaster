import { IsEmail } from 'class-validator';

/**
 * Phase 6B — `POST /auth/forgot-password`. Deliberately the only field:
 * the response is identical regardless of whether this email matches an
 * account (PasswordResetService.requestReset's own doc comment).
 */
export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}
