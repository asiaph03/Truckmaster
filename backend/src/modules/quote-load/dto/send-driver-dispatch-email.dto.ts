import { IsEmail, IsOptional } from 'class-validator';

/**
 * Driver Dispatch Email feature — `manualRecipientEmail` is a one-time
 * override for this single send only (never persisted, never written to
 * Driver/DispatchRecord) — used only when the assigned driver has no
 * email on file. Validated as a real email address when present; the
 * driver's own on-file email, when it exists, always takes priority and
 * this field is ignored in that case (see
 * CarrierSourcingService.resolveDriverDispatchContext).
 */
export class SendDriverDispatchEmailDto {
  @IsOptional()
  @IsEmail()
  manualRecipientEmail?: string;
}
