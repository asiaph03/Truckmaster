import { Injectable, Logger } from '@nestjs/common';
import { EmailAttachment, IEmailSender } from './email-sender.interface';

/**
 * Task #6 — E2E/test-mode defense-in-depth. Bound instead of
 * PostmarkEmailSender whenever nodeEnv === 'test' (see EmailModule's
 * chooseEmailSender). Makes zero network calls and always resolves —
 * this is on top of, not instead of, the per-e2e-spec
 * `.overrideProvider(EMAIL_SENDER)` calls already in the 19 spec files:
 * those protect the common case, this protects the residual case where a
 * spec forgets to override it (the real PostmarkEmailSender would
 * otherwise still attempt a real, if auth-rejected, HTTPS call to
 * Postmark using whatever E2E_POSTMARK_API_KEY is configured).
 */
@Injectable()
export class NoopEmailSender implements IEmailSender {
  private readonly logger = new Logger(NoopEmailSender.name);

  async send(message: {
    to: string;
    subject: string;
    body: string;
    attachments?: EmailAttachment[];
  }): Promise<void> {
    this.logger.warn(
      `NODE_ENV=test — email to ${message.to} ("${message.subject}") not sent ` +
        '(NoopEmailSender, Task #6 E2E/test-mode isolation).',
    );
  }
}
