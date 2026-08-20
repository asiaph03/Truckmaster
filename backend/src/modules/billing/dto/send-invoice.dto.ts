import { IsEmail, IsString, MinLength } from 'class-validator';

/** TECHNICAL_ARCHITECTURE.md §5.2's exact locked request shape for `POST /invoices/:id/send`. */
export class SendInvoiceDto {
  @IsEmail()
  recipientEmail!: string;

  @IsString()
  @MinLength(1)
  subject!: string;

  @IsString()
  @MinLength(1)
  message!: string;
}
