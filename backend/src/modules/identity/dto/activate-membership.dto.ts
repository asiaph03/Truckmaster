import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Workflow 1 §1.3 (initial Admin verification) and §1.5 (invitee
 * activation) — mechanically the same operation (Decision 1's "Workflow 1
 * mechanics" note). `password` is required unless the underlying global
 * User already has one (an existing identity being added to a new
 * organization, Decision 1 — "no new password, no re-verification
 * needed") — enforced in the service layer, since it's conditional on
 * server-side state the DTO itself can't know.
 */
export class ActivateMembershipDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  password?: string;
}
