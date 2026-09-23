import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UserService } from './user.service';
import { TokenService } from './token.service';
import { PasswordService } from './password.service';
import { SessionRegistryService } from './session-registry.service';
import { AppConfig } from '../../../config/configuration';
import { AuthenticationError } from '../../../common/errors/app-error';
import {
  EMAIL_QUEUE,
  EmailJobData,
  EMAIL_JOB_OPTIONS,
} from '../../../common/email/email-queue.constants';

/** Phase 6B locked decision — exactly 1 hour, not the 7-day invitation convention. */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Phase 6B — forgot-password / password-reset. A deliberately separate
 * service from AuthService: this is an unauthenticated-entry-point
 * concern (token issuance/consumption) with its own dependencies
 * (TokenService, the email queue, SessionRegistryService's user-wide
 * invalidation), not a variant of an already-authenticated profile
 * update (AuthService.updateProfile).
 *
 * PasswordResetToken is a global, User-scoped table (no organization_id,
 * no RLS policy — same exemption as User/Organization themselves), so
 * every query here uses `this.prisma`/`tx` directly, never
 * withTenantTransaction/withUserTransaction/withInvitationTokenTransaction
 * (those exist specifically to set an RLS session variable this table
 * has no policy checking).
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly userService: UserService,
    private readonly tokenService: TokenService,
    private readonly passwordService: PasswordService,
    private readonly sessionRegistry: SessionRegistryService,
    @Inject(EMAIL_QUEUE) private readonly emailQueue: Queue,
    private readonly config: ConfigService<AppConfig>,
  ) {}

  /**
   * §5 of the locked design — always resolves with no observable
   * difference between "email matched a qualifying account" and every
   * other case (no such user, no password set yet, not ACTIVE). The
   * qualification check below is deliberately the exact same one
   * AuthService.login already uses to decide whether an identity can
   * authenticate at all: an identity that couldn't log in today has
   * nothing meaningful to "reset." The controller always returns the
   * same response regardless of which branch this method takes — the
   * only internal difference is whether an email gets enqueued.
   */
  async requestReset(email: string): Promise<void> {
    const user = await this.userService.findByEmail(email);
    if (!user || !user.passwordHash || user.status !== 'ACTIVE') {
      return;
    }

    const { raw: rawToken, hash: tokenHash } = this.tokenService.generate();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      // §4 — a new request invalidates every previously issued, still-
      // unused token for this user first, so at most one reset token is
      // ever simultaneously valid (same "supersede the old one" intent as
      // MembershipService.resend(), applied here as an explicit bulk
      // invalidation since this table, unlike OrganizationMembership,
      // isn't a single mutable row per identity).
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      await tx.passwordResetToken.create({
        data: { userId: user.id, tokenHash, expiresAt },
      });
    });

    // §11 — userId only, never the email/raw token.
    this.logger.log(`event=password_reset_requested userId=${user.id}`);

    // §9/§10 — identity-scoped: no organizationId/entityType/entityId.
    // §10 — the raw token appears only in this outbound email payload,
    // never logged, never persisted.
    const appBaseUrl = this.config.get('appBaseUrl', { infer: true });
    await this.emailQueue.add(
      'send',
      {
        to: user.email,
        subject: 'Reset your Truck Master TMS password',
        body: `A password reset was requested for your account. Reset it: ${appBaseUrl}/reset-password?token=${rawToken}\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email.`,
      } satisfies EmailJobData,
      EMAIL_JOB_OPTIONS,
    );
  }

  /**
   * §7 — one atomic transaction: validate+consume the token and update
   * the password together, so a failure at any step (including password
   * validation) leaves the token unconsumed (the transaction rolls back
   * the `usedAt` write along with everything else). §8 (session
   * invalidation) deliberately happens AFTER the transaction commits —
   * it's a Redis, not a Postgres, side effect, matching this codebase's
   * established "queue/cache side effects happen after the DB transaction
   * resolves" convention (e.g. OrganizationService.createOrganization's
   * email enqueue, outside its own $transaction).
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = this.tokenService.hash(rawToken);

    const userId = await this.prisma.$transaction(async (tx) => {
      // A conditional UPDATE's WHERE clause is re-evaluated under the row
      // lock the UPDATE statement itself acquires, so two concurrent
      // requests for the same token serialize on that row: whichever
      // commits first flips usedAt, and the second's WHERE no longer
      // matches, so its affected-row count is 0. No separate
      // `SELECT ... FOR UPDATE` is needed — unlike Phase 4's
      // convertSubscription (which locks because it also needs to read
      // other pre-update columns under that lock), here the UPDATE's own
      // affected-row count is the only signal this method needs.
      const consumed = await tx.passwordResetToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (consumed.count === 0) {
        throw new AuthenticationError('This password reset link is invalid or has expired.');
      }

      const tokenRow = await tx.passwordResetToken.findFirstOrThrow({ where: { tokenHash } });

      // §7 step 3 — validated/hashed via the existing PasswordService,
      // the single source of truth for password rules (throws
      // ValidationError for a non-conforming password, which rolls this
      // whole transaction back, including the usedAt write above).
      const passwordHash = await this.passwordService.hash(newPassword);

      // §14 — status/emailVerifiedAt are deliberately left untouched: a
      // reset token only ever reaches this point for an already-ACTIVE
      // user with an existing password (requestReset's own qualification
      // check above), so there is no "first activation" to perform here
      // — only the password itself changes, and no other User field.
      await tx.user.update({
        where: { id: tokenRow.userId },
        data: { passwordHash },
      });

      return tokenRow.userId;
    });

    this.logger.log(`event=password_reset_completed userId=${userId}`);

    // §8 — every session for this user becomes invalid, regardless of
    // organization-selection state (org-selected, org-pending, or
    // no-workspace) — see SessionRegistryService.revokeAllForUser's own
    // doc comment for why this can't be done by iterating memberships.
    await this.sessionRegistry.revokeAllForUser(userId);
  }
}
