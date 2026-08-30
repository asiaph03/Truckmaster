import { CarrierService } from './carrier.service';
import {
  BusinessRuleError,
  ConflictError,
  EligibilityError,
} from '../../../common/errors/app-error';

describe('CarrierService', () => {
  const ORG_ID = 'org-1';
  const ACTING_USER = 'user-1';

  const CREATE_DTO = {
    legalName: 'Acme Trucking',
    mcNumber: 'MC-123',
    dotNumber: 'DOT-456',
    addressLine1: '1 Main St',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
    primaryContactName: 'Dispatch',
    primaryContactPhone: '555-0100',
    primaryContactEmail: 'dispatch@acme-trucking.test',
  };

  function buildService(opts: {
    duplicateCarrier?: { id: string } | null;
    carrier?: Record<string, unknown>;
    activationReadiness?: { eligible: boolean; reasons: string[] };
  }) {
    const carrierRow = opts.carrier ?? {
      id: 'carrier-1',
      organizationId: ORG_ID,
      status: 'PENDING',
      assignmentEligible: false,
    };

    // create() calls tx.carrier.findFirst for the MC/DOT duplicate check;
    // update()/activate() call the same method to load the target carrier
    // by id. opts.carrier (activate/update tests) takes priority so those
    // tests see the real carrier row rather than the duplicate-check
    // fixture, which only create() tests populate.
    const findFirstResult = opts.carrier ?? opts.duplicateCarrier ?? null;

    const tx = {
      carrier: {
        findFirst: jest.fn().mockResolvedValue(findFirstResult),
        create: jest.fn().mockResolvedValue(carrierRow),
        update: jest.fn().mockResolvedValue({ ...carrierRow, status: 'ACTIVE' }),
      },
    };

    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
      carrier: { findFirst: jest.fn().mockResolvedValue(carrierRow) },
    };

    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const eligibility = {
      checkActivationReadiness: jest
        .fn()
        .mockResolvedValue(opts.activationReadiness ?? { eligible: true, reasons: [] }),
      recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }),
    };

    const service = new CarrierService(prisma as never, audit as never, eligibility as never);
    return { service, tx, prisma, audit, eligibility, carrierRow };
  }

  describe('create — Workflow 3 §3.2 MC/DOT duplicate hard block', () => {
    it('creates a carrier with status PENDING and assignmentEligible false when MC/DOT are unique', async () => {
      const { service, tx } = buildService({ duplicateCarrier: null });

      await service.create(ORG_ID, CREATE_DTO, ACTING_USER);

      expect(tx.carrier.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PENDING', assignmentEligible: false }),
        }),
      );
    });

    it('hard-blocks creation when the MC or DOT number already exists in the org (never a warning)', async () => {
      const { service, tx } = buildService({ duplicateCarrier: { id: 'existing-carrier' } });

      await expect(service.create(ORG_ID, CREATE_DTO, ACTING_USER)).rejects.toThrow(ConflictError);
      expect(tx.carrier.create).not.toHaveBeenCalled();
    });

    it('scopes the duplicate check to organization + (mcNumber OR dotNumber)', async () => {
      const { service, tx } = buildService({ duplicateCarrier: null });

      await service.create(ORG_ID, CREATE_DTO, ACTING_USER);

      expect(tx.carrier.findFirst).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          OR: [{ mcNumber: CREATE_DTO.mcNumber }, { dotNumber: CREATE_DTO.dotNumber }],
        },
      });
    });
  });

  describe('activate — Workflow 3 §3.7', () => {
    it('rejects activation when the carrier is not currently Pending', async () => {
      const { service } = buildService({ carrier: { id: 'c1', status: 'ACTIVE' } });

      await expect(service.activate(ORG_ID, 'c1', ACTING_USER)).rejects.toThrow(BusinessRuleError);
    });

    it('rejects activation with EligibilityError listing unmet conditions', async () => {
      const { service } = buildService({
        carrier: { id: 'c1', status: 'PENDING' },
        activationReadiness: { eligible: false, reasons: ['W9 is not approved'] },
      });

      await expect(service.activate(ORG_ID, 'c1', ACTING_USER)).rejects.toThrow(EligibilityError);
    });

    it('activates a Pending carrier when all compliance conditions are met, then recalculates eligibility', async () => {
      const { service, tx, eligibility } = buildService({
        carrier: { id: 'c1', status: 'PENDING' },
        activationReadiness: { eligible: true, reasons: [] },
      });

      await service.activate(ORG_ID, 'c1', ACTING_USER);

      expect(tx.carrier.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'ACTIVE' },
      });
      expect(eligibility.recalculate).toHaveBeenCalledWith(tx, ORG_ID, 'c1');
    });
  });

  describe('findById — activation readiness (Activate button gating)', () => {
    it('exposes activationReady=true for a Pending carrier that passes all 6 compliance checks', async () => {
      const { service, eligibility } = buildService({
        carrier: { id: 'c1', status: 'PENDING', assignmentEligible: false },
        activationReadiness: { eligible: true, reasons: [] },
      });

      const result = await service.findById(ORG_ID, 'c1');

      expect(result.activationReady).toBe(true);
      expect(result.activationReasons).toEqual([]);
      expect(eligibility.checkActivationReadiness).toHaveBeenCalledWith(
        expect.anything(),
        ORG_ID,
        'c1',
      );
      // assignmentEligible is untouched -- still the structurally-always-false
      // recalculate() result for a Pending carrier, not the readiness check.
      expect(result.assignmentEligible).toBe(false);
    });

    it('exposes activationReady=false with the unmet reasons when a compliance requirement fails', async () => {
      const { service } = buildService({
        carrier: { id: 'c1', status: 'PENDING', assignmentEligible: false },
        activationReadiness: { eligible: false, reasons: ['Notice of Assignment is not approved'] },
      });

      const result = await service.findById(ORG_ID, 'c1');

      expect(result.activationReady).toBe(false);
      expect(result.activationReasons).toEqual(['Notice of Assignment is not approved']);
    });

    it('does not compute activation readiness for an Active carrier -- assignmentEligible remains the signal', async () => {
      const { service, eligibility } = buildService({
        carrier: {
          id: 'c1',
          status: 'ACTIVE',
          assignmentEligible: true,
          ineligibilityReasons: [],
        },
      });

      const result = await service.findById(ORG_ID, 'c1');

      expect(result.activationReady).toBeUndefined();
      expect(eligibility.checkActivationReadiness).not.toHaveBeenCalled();
      expect(result.assignmentEligible).toBe(true);
      expect(result.ineligibilityReasons).toEqual([]);
    });
  });
});
