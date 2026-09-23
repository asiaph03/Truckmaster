import { Injectable } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import { BusinessRuleError } from '../errors/app-error';

export type EffectiveSubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';

interface OrganizationSubscriptionSnapshot {
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  maxCarriers: number | null;
  maxDrivers: number | null;
}

/**
 * Phase 2 — per-organization entitlement enforcement (demo/trial carrier
 * and driver limits). Reused by exactly the 5 CarrierService methods that
 * can increase a carrier's or driver's counted total: create, activate,
 * reactivateCarrier, addDriver, reactivateDriver. blockCarrier/
 * deactivateCarrier/deactivateDriver never call this service — they only
 * ever decrease the counted total.
 *
 * `maxCarriers`/`maxDrivers: null` means unlimited — every existing
 * production organization has both null (Phase 1 migration default), so
 * every check below short-circuits to a no-op for them via a plain,
 * unlocked read before ever taking the Organization row lock.
 *
 * TRIAL -> EXPIRED is derived live from `trialEndsAt` (resolveEffectiveStatus)
 * rather than trusted from the stored `subscriptionStatus` column, so
 * enforcement is correct immediately and never depends on a scheduled sweep
 * (Phase 5, not yet built) having run.
 */
@Injectable()
export class EntitlementService {
  /** Pure function — no I/O. Exposed for direct unit testing. */
  resolveEffectiveStatus(
    org: Pick<OrganizationSubscriptionSnapshot, 'subscriptionStatus' | 'trialEndsAt'>,
    now: Date,
  ): EffectiveSubscriptionStatus {
    if (org.subscriptionStatus === 'CANCELLED') return 'CANCELLED';
    if (org.subscriptionStatus === 'EXPIRED') return 'EXPIRED';
    if (org.subscriptionStatus === 'TRIAL') {
      if (org.trialEndsAt != null && now.getTime() >= org.trialEndsAt.getTime()) return 'EXPIRED';
      return 'TRIAL';
    }
    return 'ACTIVE';
  }

  /** Used by CarrierService.create() — expired-trial block + slot check. */
  async assertCanCreateCarrier(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    const quick = await this.readOrganizationSubscription(tx, organizationId);
    this.assertNotExpired(quick, 'add more carriers');
    await this.assertCarrierCountWithinLimit(tx, organizationId, quick);
  }

  /** Used by CarrierService.activate()/reactivateCarrier() — slot check only, no expired-trial block. */
  async assertCarrierSlotAvailable(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    const quick = await this.readOrganizationSubscription(tx, organizationId);
    await this.assertCarrierCountWithinLimit(tx, organizationId, quick);
  }

  /**
   * Phase 3 — used by QuoteService.create() and LoadService.createFromBooking()
   * (the single, shared creation method behind both direct Load booking and
   * Quote → Load conversion — see that method's own doc comment). Quote and
   * Load have no configured count limit (no maxQuotes/maxLoads field exists,
   * and none is being added here) — this is a pure expired-trial status
   * gate, reusing the same `resolveEffectiveStatus`/`assertNotExpired` this
   * class already uses for carriers/drivers, with no row lock: there is no
   * shared counted resource to protect against a race on, so
   * `SELECT ... FOR UPDATE` would be pure overhead here.
   */
  async assertCanCreateOperationalRecord(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    const quick = await this.readOrganizationSubscription(tx, organizationId);
    this.assertNotExpired(quick, 'create new operational records');
  }

  /** Used by CarrierService.addDriver() — expired-trial block + slot check. */
  async assertCanCreateDriver(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
    const quick = await this.readOrganizationSubscription(tx, organizationId);
    this.assertNotExpired(quick, 'add more drivers');
    await this.assertDriverCountWithinLimit(tx, organizationId, quick);
  }

  /** Used by CarrierService.reactivateDriver() — slot check only, no expired-trial block. */
  async assertDriverSlotAvailable(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    const quick = await this.readOrganizationSubscription(tx, organizationId);
    await this.assertDriverCountWithinLimit(tx, organizationId, quick);
  }

  private assertNotExpired(
    org: Pick<OrganizationSubscriptionSnapshot, 'subscriptionStatus' | 'trialEndsAt'>,
    action: string,
  ): void {
    if (this.resolveEffectiveStatus(org, new Date()) === 'EXPIRED') {
      throw new BusinessRuleError(
        `Your trial has expired. Convert to a paid subscription to ${action}.`,
      );
    }
  }

  /**
   * Skips the row lock entirely when `maxCarriers` is null on this
   * unlocked read (the common case — every existing org). Only when a
   * limit is actually configured does it re-read under `FOR UPDATE` and
   * count, so two concurrent requests for the same org serialize on that
   * lock rather than both reading a stale pre-insert count.
   */
  private async assertCarrierCountWithinLimit(
    tx: Prisma.TransactionClient,
    organizationId: string,
    quick: OrganizationSubscriptionSnapshot,
  ): Promise<void> {
    if (quick.maxCarriers == null) return;

    const locked = await this.lockOrganizationRow(tx, organizationId);
    if (locked.maxCarriers == null) return;

    const count = await tx.carrier.count({
      where: { organizationId, status: { in: ['PENDING', 'ACTIVE'] } },
    });
    if (count >= locked.maxCarriers) {
      throw new BusinessRuleError(
        `This organization has reached its carrier limit (${locked.maxCarriers}).`,
      );
    }
  }

  private async assertDriverCountWithinLimit(
    tx: Prisma.TransactionClient,
    organizationId: string,
    quick: OrganizationSubscriptionSnapshot,
  ): Promise<void> {
    if (quick.maxDrivers == null) return;

    const locked = await this.lockOrganizationRow(tx, organizationId);
    if (locked.maxDrivers == null) return;

    const count = await tx.driver.count({
      where: { organizationId, active: true },
    });
    if (count >= locked.maxDrivers) {
      throw new BusinessRuleError(
        `This organization has reached its driver limit (${locked.maxDrivers}).`,
      );
    }
  }

  private async readOrganizationSubscription(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<OrganizationSubscriptionSnapshot> {
    return tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: {
        subscriptionStatus: true,
        trialEndsAt: true,
        maxCarriers: true,
        maxDrivers: true,
      },
    });
  }

  /**
   * `SELECT ... FOR UPDATE` on the Organization row — must be called
   * inside the same transaction as the subsequent count + create/update,
   * never a separate transaction, or the lock is meaningless. Combines the
   * lock with re-reading the limit columns in one round trip.
   */
  private async lockOrganizationRow(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<OrganizationSubscriptionSnapshot> {
    const rows = await tx.$queryRaw<OrganizationSubscriptionSnapshot[]>`
      SELECT
        subscription_status AS "subscriptionStatus",
        trial_ends_at        AS "trialEndsAt",
        max_carriers          AS "maxCarriers",
        max_drivers             AS "maxDrivers"
      FROM organization
      WHERE id = ${organizationId}::uuid
      FOR UPDATE
    `;
    return rows[0];
  }
}
