import { EntitlementService } from './entitlement.service';
import { BusinessRuleError } from '../errors/app-error';

describe('EntitlementService.resolveEffectiveStatus', () => {
  const service = new EntitlementService();
  const NOW = new Date('2026-09-23T12:00:00.000Z');

  it('returns CANCELLED regardless of trialEndsAt', () => {
    expect(
      service.resolveEffectiveStatus({ subscriptionStatus: 'CANCELLED', trialEndsAt: null }, NOW),
    ).toBe('CANCELLED');
  });

  it('returns EXPIRED when already stored as EXPIRED', () => {
    expect(
      service.resolveEffectiveStatus({ subscriptionStatus: 'EXPIRED', trialEndsAt: null }, NOW),
    ).toBe('EXPIRED');
  });

  it('returns ACTIVE for a stored ACTIVE org', () => {
    expect(
      service.resolveEffectiveStatus({ subscriptionStatus: 'ACTIVE', trialEndsAt: null }, NOW),
    ).toBe('ACTIVE');
  });

  it('returns TRIAL when trialEndsAt is still in the future', () => {
    const trialEndsAt = new Date('2026-09-24T00:00:00.000Z');
    expect(service.resolveEffectiveStatus({ subscriptionStatus: 'TRIAL', trialEndsAt }, NOW)).toBe(
      'TRIAL',
    );
  });

  it('derives EXPIRED live once trialEndsAt has passed, even though the stored value is still TRIAL', () => {
    const trialEndsAt = new Date('2026-09-22T00:00:00.000Z');
    expect(service.resolveEffectiveStatus({ subscriptionStatus: 'TRIAL', trialEndsAt }, NOW)).toBe(
      'EXPIRED',
    );
  });

  it('derives EXPIRED at the exact trialEndsAt instant (>=, not >)', () => {
    const trialEndsAt = NOW;
    expect(service.resolveEffectiveStatus({ subscriptionStatus: 'TRIAL', trialEndsAt }, NOW)).toBe(
      'EXPIRED',
    );
  });

  it('returns TRIAL when trialEndsAt is null (no expiration set yet)', () => {
    expect(
      service.resolveEffectiveStatus({ subscriptionStatus: 'TRIAL', trialEndsAt: null }, NOW),
    ).toBe('TRIAL');
  });
});

describe('EntitlementService — carrier/driver slot checks (mocked tx)', () => {
  const ORG_ID = 'org-1';

  function buildTx(opts: {
    subscriptionStatus?: string;
    trialEndsAt?: Date | null;
    maxCarriers?: number | null;
    maxDrivers?: number | null;
    carrierCount?: number;
    driverCount?: number;
  }) {
    const snapshot = {
      subscriptionStatus: opts.subscriptionStatus ?? 'ACTIVE',
      trialEndsAt: opts.trialEndsAt ?? null,
      maxCarriers: opts.maxCarriers ?? null,
      maxDrivers: opts.maxDrivers ?? null,
    };
    const calls: string[] = [];

    const tx = {
      organization: {
        findUniqueOrThrow: jest.fn().mockImplementation(() => {
          calls.push('unlockedRead');
          return Promise.resolve(snapshot);
        }),
      },
      $queryRaw: jest.fn().mockImplementation(() => {
        calls.push('lock');
        return Promise.resolve([snapshot]);
      }),
      carrier: {
        count: jest.fn().mockImplementation((args) => {
          calls.push('carrierCount');
          return Promise.resolve(opts.carrierCount ?? 0);
        }),
      },
      driver: {
        count: jest.fn().mockImplementation((args) => {
          calls.push('driverCount');
          return Promise.resolve(opts.driverCount ?? 0);
        }),
      },
    };

    return { tx, calls };
  }

  describe('assertCarrierSlotAvailable', () => {
    it('never takes the row lock when maxCarriers is null (unlimited)', async () => {
      const service = new EntitlementService();
      const { tx, calls } = buildTx({ maxCarriers: null });

      await service.assertCarrierSlotAvailable(tx as never, ORG_ID);

      expect(calls).toEqual(['unlockedRead']);
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('locks the org row, then counts, in that order, when a limit is configured', async () => {
      const service = new EntitlementService();
      const { tx, calls } = buildTx({ maxCarriers: 1, carrierCount: 0 });

      await service.assertCarrierSlotAvailable(tx as never, ORG_ID);

      expect(calls).toEqual(['unlockedRead', 'lock', 'carrierCount']);
    });

    it('counts only PENDING and ACTIVE carriers', async () => {
      const service = new EntitlementService();
      const { tx } = buildTx({ maxCarriers: 1, carrierCount: 0 });

      await service.assertCarrierSlotAvailable(tx as never, ORG_ID);

      expect(tx.carrier.count).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID, status: { in: ['PENDING', 'ACTIVE'] } },
      });
    });

    it('rejects with BusinessRuleError when the count is already at the limit', async () => {
      const service = new EntitlementService();
      const { tx } = buildTx({ maxCarriers: 1, carrierCount: 1 });

      await expect(service.assertCarrierSlotAvailable(tx as never, ORG_ID)).rejects.toThrow(
        BusinessRuleError,
      );
    });

    it('allows creation when the count is below the limit', async () => {
      const service = new EntitlementService();
      const { tx } = buildTx({ maxCarriers: 1, carrierCount: 0 });

      await expect(
        service.assertCarrierSlotAvailable(tx as never, ORG_ID),
      ).resolves.toBeUndefined();
    });

    it('does not throw the expired-trial error even when the trial is expired — slot-only', async () => {
      const service = new EntitlementService();
      const { tx } = buildTx({
        subscriptionStatus: 'TRIAL',
        trialEndsAt: new Date('2000-01-01'),
        maxCarriers: 5,
        carrierCount: 0,
      });

      await expect(
        service.assertCarrierSlotAvailable(tx as never, ORG_ID),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertCanCreateCarrier', () => {
    it('rejects with BusinessRuleError when the trial has expired, before ever counting', async () => {
      const service = new EntitlementService();
      const { tx, calls } = buildTx({
        subscriptionStatus: 'TRIAL',
        trialEndsAt: new Date('2000-01-01'),
        maxCarriers: 5,
      });

      await expect(service.assertCanCreateCarrier(tx as never, ORG_ID)).rejects.toThrow(
        BusinessRuleError,
      );
      expect(calls).toEqual(['unlockedRead']);
      expect(tx.carrier.count).not.toHaveBeenCalled();
    });

    it('allows creation for a non-expired org below its carrier limit', async () => {
      const service = new EntitlementService();
      const { tx } = buildTx({
        subscriptionStatus: 'TRIAL',
        trialEndsAt: new Date('2099-01-01'),
        maxCarriers: 1,
        carrierCount: 0,
      });

      await expect(service.assertCanCreateCarrier(tx as never, ORG_ID)).resolves.toBeUndefined();
    });

    it('rejects with BusinessRuleError when at the carrier limit (not expired)', async () => {
      const service = new EntitlementService();
      const { tx } = buildTx({ maxCarriers: 1, carrierCount: 1 });

      await expect(service.assertCanCreateCarrier(tx as never, ORG_ID)).rejects.toThrow(
        BusinessRuleError,
      );
    });

    it('never locks or counts for an unlimited, non-expired org', async () => {
      const service = new EntitlementService();
      const { tx, calls } = buildTx({ maxCarriers: null });

      await service.assertCanCreateCarrier(tx as never, ORG_ID);

      expect(calls).toEqual(['unlockedRead']);
    });
  });

  describe('assertDriverSlotAvailable', () => {
    it('never takes the row lock when maxDrivers is null', async () => {
      const service = new EntitlementService();
      const { tx, calls } = buildTx({ maxDrivers: null });

      await service.assertDriverSlotAvailable(tx as never, ORG_ID);

      expect(calls).toEqual(['unlockedRead']);
    });

    it('counts organization-wide active drivers (not scoped to a single carrier)', async () => {
      const service = new EntitlementService();
      const { tx } = buildTx({ maxDrivers: 5, driverCount: 4 });

      await service.assertDriverSlotAvailable(tx as never, ORG_ID);

      expect(tx.driver.count).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID, active: true },
      });
    });

    it('rejects when at the driver limit', async () => {
      const service = new EntitlementService();
      const { tx } = buildTx({ maxDrivers: 5, driverCount: 5 });

      await expect(service.assertDriverSlotAvailable(tx as never, ORG_ID)).rejects.toThrow(
        BusinessRuleError,
      );
    });

    it('does not apply the expired-trial block — slot-only', async () => {
      const service = new EntitlementService();
      const { tx } = buildTx({
        subscriptionStatus: 'TRIAL',
        trialEndsAt: new Date('2000-01-01'),
        maxDrivers: 5,
        driverCount: 0,
      });

      await expect(service.assertDriverSlotAvailable(tx as never, ORG_ID)).resolves.toBeUndefined();
    });
  });

  describe('assertCanCreateDriver', () => {
    it('rejects with BusinessRuleError when the trial has expired, before ever counting', async () => {
      const service = new EntitlementService();
      const { tx } = buildTx({
        subscriptionStatus: 'TRIAL',
        trialEndsAt: new Date('2000-01-01'),
        maxDrivers: 5,
      });

      await expect(service.assertCanCreateDriver(tx as never, ORG_ID)).rejects.toThrow(
        BusinessRuleError,
      );
      expect(tx.driver.count).not.toHaveBeenCalled();
    });

    it('allows creation for a non-expired org below its driver limit', async () => {
      const service = new EntitlementService();
      const { tx } = buildTx({ maxDrivers: 5, driverCount: 4 });

      await expect(service.assertCanCreateDriver(tx as never, ORG_ID)).resolves.toBeUndefined();
    });
  });
});
