import { Injectable, Logger } from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { NotificationService } from '../../notification/services/notification.service';

/** Task #9 — same shape as the other sweeps' ADMIN_VISIBILITY_ROLES. */
const ADMIN_VISIBILITY_ROLES: MembershipRoleName[] = ['ADMIN'];

/**
 * Monitoring Phase 4A-17 — a class-name-only error identifier, never
 * error.message/.stack. Safe by construction: a JS/TS class name is
 * developer-defined source text, never runtime/user-controlled content.
 */
function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Workflow 4 §4.5 — unlike the invitation-expiration case, no lazy
 * check exists anywhere for Quotes today: an `OPEN` Quote past its
 * `expirationDate` currently sits there forever with no code path
 * transitioning it. This sweep is the first implementation of §4.5's
 * automatic `OPEN → LOST` rule, not just proactive housekeeping.
 */
@Injectable()
export class QuoteExpirationSweepService {
  private readonly logger = new Logger(QuoteExpirationSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private async loadStaleQuotes(organizationId: string) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.quote.findMany({
        where: {
          organizationId,
          status: 'OPEN',
          expirationDate: { lt: new Date() },
        },
      }),
    );
  }

  /** Monitoring Phase 4A-2 — see InvitationExpirationSweepService.run() for why each org/record gets its own transaction. */
  async run(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    // Monitoring Phase 4A-10 — local to this run() invocation only, see
    // InvitationExpirationSweepService.run() for the full concurrency
    // reasoning (all 6 sweeps share one worker at concurrency 1).
    let orgsScanned = 0;
    let recordsMatched = 0;
    let recordsSucceeded = 0;
    let recordsFailed = 0;

    for (const org of orgs) {
      orgsScanned++;

      let stale: Awaited<ReturnType<typeof this.loadStaleQuotes>>;
      try {
        stale = await this.loadStaleQuotes(org.id);
      } catch (error) {
        this.logger.error(
          `Quote expiration sweep: failed to load candidates for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      recordsMatched += stale.length;

      for (const quote of stale) {
        try {
          await this.prisma.withTenantTransaction(org.id, async (tx) => {
            await tx.quote.update({
              where: { id: quote.id },
              data: { status: 'LOST', lossReason: 'Expired' },
            });

            await this.audit.record(tx, {
              organizationId: org.id,
              action: 'Quote Expired — Automatically Marked Lost',
              entityType: 'Quote',
              entityId: quote.id,
              actorType: 'SYSTEM',
            });

            const existingNotification = await tx.notification.findFirst({
              where: {
                organizationId: org.id,
                type: 'QUOTE_EXPIRED',
                relatedEntityType: 'Quote',
                relatedEntityId: quote.id,
              },
            });
            if (!existingNotification) {
              await this.notifications.createForUserAndRoles(
                tx,
                org.id,
                quote.createdByUserId,
                ADMIN_VISIBILITY_ROLES,
                {
                  type: 'QUOTE_EXPIRED',
                  message: `Quote expired — ${quote.quoteNumber}`,
                  relatedEntityType: 'Quote',
                  relatedEntityId: quote.id,
                },
              );
            }
          });
          recordsSucceeded++;
        } catch (error) {
          recordsFailed++;
          this.logger.error(
            `Quote expiration sweep: failed for org ${org.id}, quote ${quote.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }
    }

    const summary = `Quote expiration sweep summary: orgsScanned=${orgsScanned} recordsMatched=${recordsMatched} recordsSucceeded=${recordsSucceeded} recordsFailed=${recordsFailed}`;
    if (recordsFailed > 0) {
      this.logger.warn(summary);
    } else {
      this.logger.log(summary);
    }
  }
}
