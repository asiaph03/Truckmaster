import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { IEmailSender } from './email-sender.interface';

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
  constructor(private readonly config: ConfigService<AppConfig>) {}

  async send(message: { to: string; subject: string; body: string }): Promise<void> {
    const { apiKey, fromAddress } = this.config.get('postmark', { infer: true })!;

    const response = await fetch(POSTMARK_SEND_URL, {
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
      }),
    });

    const result = (await response.json().catch(() => undefined)) as PostmarkResponse | undefined;

    if (!response.ok || !result || result.ErrorCode !== 0) {
      const detail = result?.Message ?? `HTTP ${response.status}`;
      throw new Error(`Postmark send failed: ${detail}`);
    }
  }
}
