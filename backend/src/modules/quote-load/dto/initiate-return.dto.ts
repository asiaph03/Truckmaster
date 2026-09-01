import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Return Product feature — the "Initiate Return" action's per-stop input.
 * Same field set as `LoadStopInputDto` minus `sequence`/`stopType`: both
 * are implied by which side of `InitiateReturnDto` this is (pickupStop is
 * always sequence = next, stopType = PICKUP; deliveryStop is always
 * sequence = next + 1, stopType = DELIVERY) and resolved server-side in
 * `DispatchTrackingService.initiateReturn`, never caller-supplied —
 * mirrors why `UpdateStopItemDto` never lets `sequence` be written either.
 */
export class ReturnStopInputDto {
  @IsOptional()
  @IsUUID()
  customerLocationId?: string;

  @IsString()
  @MinLength(1)
  companyName!: string;

  @IsString()
  @MinLength(1)
  addressLine1!: string;

  @IsString()
  @MinLength(1)
  city!: string;

  @IsString()
  @MinLength(2)
  state!: string;

  @IsString()
  @MinLength(1)
  zip!: string;

  @IsOptional()
  @IsDateString()
  appointmentDatetime?: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * `POST /loads/:id/stops/return` — appends exactly one PICKUP/RETURN +
 * one DELIVERY/RETURN stop pair to an existing Load. Always both stops
 * together, never one alone — a return is only ever a pickup-then-
 * delivery pair, matching the user-facing "Return Pickup" / "Return
 * Delivery" framing in the Initiate Return modal.
 */
export class InitiateReturnDto {
  @ValidateNested()
  @Type(() => ReturnStopInputDto)
  pickupStop!: ReturnStopInputDto;

  @ValidateNested()
  @Type(() => ReturnStopInputDto)
  deliveryStop!: ReturnStopInputDto;
}
