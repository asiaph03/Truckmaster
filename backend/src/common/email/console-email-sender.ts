import { Injectable, Logger } from '@nestjs/common';
import { IEmailSender } from './email-sender.interface';

/**
 * Development/Phase-1 stand-in for IEmailSender. Logs instead of sending —
 * swap for a real provider (SES/SendGrid/Postmark/etc.) behind the same
 * interface when one is chosen (TECHNICAL_ARCHITECTURE.md §17 R1); no
 * call site changes when that happens.
 */
@Injectable()
export class ConsoleEmailSender implements IEmailSender {
  private readonly logger = new Logger('Email');

  async send(message: { to: string; subject: string; body: string }): Promise<void> {
    this.logger.log(`[stub email] to=${message.to} subject="${message.subject}"\n${message.body}`);
  }
}
