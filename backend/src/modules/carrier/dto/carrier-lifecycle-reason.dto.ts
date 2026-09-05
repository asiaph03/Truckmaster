import { IsString, MinLength } from 'class-validator';

/**
 * Task #3 — shared by :id/block, :id/deactivate, :id/reactivate. Matches
 * CarrierRejectedDto's exact shape (@IsString + @MinLength(1)) — this
 * codebase has no established DTO-level whitespace-only rejection
 * pattern (no other "reason" DTO uses one), so a whitespace-only string
 * still passes this structural check. CarrierService.transitionStatus
 * trims the reason and is the sole, intentional authority on rejecting a
 * blank one — see the comment there.
 */
export class CarrierLifecycleReasonDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
