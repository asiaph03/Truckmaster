/**
 * Replaceable transactional email provider (TECHNICAL_ARCHITECTURE.md §1.3
 * R1 — "any provider satisfying IEmailSender works; pick during
 * deployment planning"). Mirrors the pattern already established for
 * malware scanning (Decision 10): the interface is the Stage 6/7
 * deliverable, the concrete provider is a deployment-time choice.
 *
 * Frontend Phase 16 — Postmark (`PostmarkEmailSender`) is wired behind
 * this interface via the shared `EmailModule`, queued through
 * `EMAIL_QUEUE`/`EmailSendWorker`. The verification/invitation flows
 * (Workflow 1 §1.2–§1.6) run against the real provider now.
 */
export interface IEmailSender {
  send(message: { to: string; subject: string; body: string }): Promise<void>;
}

export const EMAIL_SENDER = 'EMAIL_SENDER';
