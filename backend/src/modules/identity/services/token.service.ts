import { randomBytes, createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/**
 * Verification/invitation token handling (Workflow 1 §1.2–§1.4;
 * TECHNICAL_ARCHITECTURE.md §3.1: "verification/invitation tokens are
 * single-use, time-limited, and stored hashed, not plaintext").
 *
 * The raw token is what gets emailed to the user and is never persisted;
 * only its SHA-256 hash is stored (`OrganizationMembership.invitation_token_hash`),
 * so a database read alone can never recover a usable token.
 */
@Injectable()
export class TokenService {
  generate(): { raw: string; hash: string } {
    const raw = randomBytes(32).toString('hex');
    return { raw, hash: this.hash(raw) };
  }

  hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
