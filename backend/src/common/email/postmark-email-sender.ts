import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { EmailAttachment, EmailSendCallContext, IEmailSender } from './email-sender.interface';

const POSTMARK_SEND_URL = 'https://api.postmarkapp.com/email';

interface PostmarkResponse {
  ErrorCode: number;
  Message: string;
}

/**
 * Frontend Phase 16 — hosted transactional email provider, approved to
 * replace ConsoleEmailSender behind the unchanged IEmailSender interface.
 * A thrown error here (network/auth/rate-limit failure, or a non-zero
 * Postmark ErrorCode) is left to propagate — EmailSendWorker's
 * retry/backoff logic decides whether to retry or give up, this class
 * has no retry logic of its own.
 */
@Injectable()
export class PostmarkEmailSender implements IEmailSender {
  private readonly logger = new Logger(PostmarkEmailSender.name);

  constructor(private readonly config: ConfigService<AppConfig>) {}

  async send(
    message: {
      to: string;
      subject: string;
      body: string;
      attachments?: EmailAttachment[];
    },
    context?: EmailSendCallContext,
  ): Promise<void> {
    const { apiKey, fromAddress } = this.config.get('postmark', { infer: true })!;

    // Monitoring Phase 4A-11 — external-call timing/error attribution.
    // Instruments only the fetch() call itself; never logs the recipient,
    // subject, body, attachment content, or the API key/token.
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(POSTMARK_SEND_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': apiKey,
        },
        body: JSON.stringify({
          From: fromAddress,
          To: message.to,
          Subject: message.subject,
          TextBody: message.body,
          // Driver Dispatch Email feature — omitted entirely (not just
          // empty) when there's nothing to attach, so every existing
          // attachment-less send's request body is byte-for-byte
          // unchanged from before this feature existed.
          ...(message.attachments && message.attachments.length > 0
            ? {
                Attachments: message.attachments.map((a) => ({
                  Name: a.filename,
                  Content: a.content.toString('base64'),
                  ContentType: a.contentType,
                })),
              }
            : {}),
        }),
      });
    } catch (error) {
      this.logExternalCall(context, Date.now() - startedAt, 'failure', undefined, 'network_error');
      throw error;
    }
    const durationMs = Date.now() - startedAt;

    const result = (await response.json().catch(() => undefined)) as PostmarkResponse | undefined;

    if (!response.ok || !result || result.ErrorCode !== 0) {
      this.logExternalCall(
        context,
        durationMs,
        'failure',
        response.status,
        response.status >= 500 ? 'server_error' : 'client_error',
      );
      const detail = result?.Message ?? `HTTP ${response.status}`;
      throw new Error(`Postmark send failed: ${detail}`);
    }

    this.logExternalCall(context, durationMs, 'success', response.status);
  }

  private logExternalCall(
    context: EmailSendCallContext | undefined,
    durationMs: number,
    outcome: 'success' | 'failure',
    httpStatus?: number,
    errorCategory?: 'client_error' | 'server_error' | 'network_error',
  ): void {
    const parts = ['dependency=postmark', 'operation=send'];
    if (context?.organizationId) parts.push(`organizationId=${context.organizationId}`);
    if (context?.jobId) parts.push(`jobId=${context.jobId}`);
    parts.push(`durationMs=${durationMs}`, `outcome=${outcome}`);
    if (httpStatus !== undefined) parts.push(`httpStatus=${httpStatus}`);
    if (errorCategory !== undefined) parts.push(`errorCategory=${errorCategory}`);

    const message = parts.join(' ');
    if (outcome === 'success') {
      this.logger.log(message);
    } else {
      this.logger.warn(message);
    }
  }
}
