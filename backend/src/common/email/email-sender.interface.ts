/**
 * Replaceable transactional email provider (TECHNICAL_ARCHITECTURE.md §1.3
 * R1 — "any provider satisfying IEmailSender works; pick during
 * deployment planning"). Mirrors the pattern already established for
 * malware scanning (Decision 10): the interface is the Stage 6/7
 * deliverable, the concrete provider is a deployment-time choice.
 *
 * No provider is wired in Phase 1 — ConsoleEmailSender (below) logs the
 * email instead of sending it, which is enough to fully exercise and test
 * the verification/invitation flows (Workflow 1 §1.2–§1.6) without a real
 * provider dependency.
 */
export interface IEmailSender {
  send(message: { to: string; subject: string; body: string }): Promise<void>;
}

export const EMAIL_SENDER = 'EMAIL_SENDER';
