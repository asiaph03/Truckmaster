import { CarrierService } from './carrier.service';
import {
  BusinessRuleError,
  ConflictError,
  EligibilityError,
  NotFoundError,
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
    carrier?: Record<string, unknown> | null;
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

  describe('blockCarrier / deactivateCarrier / reactivateCarrier — Task #3', () => {
    const REASON_DTO = { reason: 'Insurance lapsed' };

    it('blocks an Active carrier, audits Carrier Blocked with reason, and recalculates eligibility', async () => {
      const { service, tx, audit, eligibility } = buildService({
        carrier: { id: 'c1', status: 'ACTIVE' },
      });

      await service.blockCarrier(ORG_ID, 'c1', REASON_DTO, ACTING_USER);

      expect(tx.carrier.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'BLOCKED' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          action: 'Carrier Blocked',
          entityType: 'Carrier',
          entityId: 'c1',
          previousValue: { status: 'ACTIVE' },
          newValue: { status: 'BLOCKED' },
          reason: 'Insurance lapsed',
          actorUserId: ACTING_USER,
        }),
      );
      expect(eligibility.recalculate).toHaveBeenCalledWith(tx, ORG_ID, 'c1');
    });

    it('deactivates an Active carrier, audits Carrier Deactivated with reason, and recalculates eligibility', async () => {
      const { service, tx, audit, eligibility } = buildService({
        carrier: { id: 'c1', status: 'ACTIVE' },
      });

      await service.deactivateCarrier(ORG_ID, 'c1', REASON_DTO, ACTING_USER);

      expect(tx.carrier.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'INACTIVE' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          action: 'Carrier Deactivated',
          previousValue: { status: 'ACTIVE' },
          newValue: { status: 'INACTIVE' },
          reason: 'Insurance lapsed',
        }),
      );
      expect(eligibility.recalculate).toHaveBeenCalledWith(tx, ORG_ID, 'c1');
    });

    it('reactivates a Blocked carrier back to Active, audits Carrier Reactivated, and recalculates eligibility', async () => {
      const { service, tx, audit, eligibility } = buildService({
        carrier: { id: 'c1', status: 'BLOCKED' },
      });

      await service.reactivateCarrier(ORG_ID, 'c1', REASON_DTO, ACTING_USER);

      expect(tx.carrier.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'ACTIVE' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          action: 'Carrier Reactivated',
          previousValue: { status: 'BLOCKED' },
          newValue: { status: 'ACTIVE' },
        }),
      );
      expect(eligibility.recalculate).toHaveBeenCalledWith(tx, ORG_ID, 'c1');
    });

    it('reactivates an Inactive carrier back to Active', async () => {
      const { service, tx } = buildService({ carrier: { id: 'c1', status: 'INACTIVE' } });

      await service.reactivateCarrier(ORG_ID, 'c1', REASON_DTO, ACTING_USER);

      expect(tx.carrier.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'ACTIVE' },
      });
    });

    it.each([
      ['blockCarrier', 'PENDING'],
      ['blockCarrier', 'BLOCKED'],
      ['blockCarrier', 'INACTIVE'],
      ['deactivateCarrier', 'PENDING'],
      ['deactivateCarrier', 'BLOCKED'],
      ['deactivateCarrier', 'INACTIVE'],
      ['reactivateCarrier', 'PENDING'],
      ['reactivateCarrier', 'ACTIVE'],
    ] as const)('rejects %s from status %s with BusinessRuleError', async (method, fromStatus) => {
      const { service, tx } = buildService({ carrier: { id: 'c1', status: fromStatus } });

      await expect(service[method](ORG_ID, 'c1', REASON_DTO, ACTING_USER)).rejects.toThrow(
        BusinessRuleError,
      );
      expect(tx.carrier.update).not.toHaveBeenCalled();
    });

    it.each(['blockCarrier', 'deactivateCarrier', 'reactivateCarrier'] as const)(
      'rejects an empty reason for %s',
      async (method) => {
        const { service } = buildService({
          carrier: { id: 'c1', status: method === 'reactivateCarrier' ? 'BLOCKED' : 'ACTIVE' },
        });

        await expect(service[method](ORG_ID, 'c1', { reason: '' }, ACTING_USER)).rejects.toThrow(
          BusinessRuleError,
        );
      },
    );

    it.each(['blockCarrier', 'deactivateCarrier', 'reactivateCarrier'] as const)(
      'rejects a whitespace-only reason for %s (trimmed before validation)',
      async (method) => {
        const { service } = buildService({
          carrier: { id: 'c1', status: method === 'reactivateCarrier' ? 'BLOCKED' : 'ACTIVE' },
        });

        await expect(
          service[method](ORG_ID, 'c1', { reason: '   \t  ' }, ACTING_USER),
        ).rejects.toThrow(BusinessRuleError);
      },
    );

    it('stores only the trimmed reason in the audit record', async () => {
      const { service, audit } = buildService({ carrier: { id: 'c1', status: 'ACTIVE' } });

      await service.blockCarrier(ORG_ID, 'c1', { reason: '  Insurance lapsed  ' }, ACTING_USER);

      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reason: 'Insurance lapsed' }),
      );
    });

    it('throws NotFoundError for a carrier outside the organization', async () => {
      const { service } = buildService({ carrier: null });

      await expect(
        service.blockCarrier(ORG_ID, 'nonexistent', REASON_DTO, ACTING_USER),
      ).rejects.toThrow(NotFoundError);
    });

    it('never touches Load, DispatchRecord, CarrierPayment, or any other entity — only reads/writes the Carrier row', async () => {
      const { service, tx } = buildService({ carrier: { id: 'c1', status: 'ACTIVE' } });

      // The shared tx mock in this file only defines a `carrier` table.
      // blockCarrier() resolving without a runtime error here is itself
      // proof its transaction body never references tx.load/
      // dispatchRecord/carrierPayment/document/etc.
      await expect(
        service.blockCarrier(ORG_ID, 'c1', REASON_DTO, ACTING_USER),
      ).resolves.toBeDefined();
      expect(Object.keys(tx)).toEqual(['carrier']);
    });
  });

  /**
   * Task #7 — a separate, local tx mock (carrier + driver) rather than
   * extending the shared buildService() above: the existing "never
   * touches...any other entity" test at line 348 asserts
   * `Object.keys(tx)).toEqual(['carrier'])`, which would break the moment
   * a `driver` table is added to that shared mock. Keeping Driver tests
   * on their own local helper protects that existing Carrier regression
   * assertion untouched.
   */
  describe('Driver management — Task #7', () => {
    const CARRIER_ID = 'carrier-1';
    const DRIVER_ID = 'driver-1';
    const REASON_DTO = { reason: 'No longer with the company' };

    function buildDriverService(opts: {
      carrier?: Record<string, unknown> | null;
      driver?: Record<string, unknown> | null;
      duplicateDriver?: Record<string, unknown> | null;
    }) {
      const carrierRow =
        'carrier' in opts ? opts.carrier : { id: CARRIER_ID, organizationId: ORG_ID };
      const driverRow =
        'driver' in opts
          ? opts.driver
          : {
              id: DRIVER_ID,
              organizationId: ORG_ID,
              carrierId: CARRIER_ID,
              firstName: 'Julia',
              lastName: 'Rivera',
              phone: '555-0100',
              email: null,
              licenseNumber: null,
              notes: null,
              active: true,
            };

      const tx = {
        carrier: {
          findFirst: jest.fn().mockResolvedValue(carrierRow),
        },
        driver: {
          // The duplicate-license-check query and the row-lookup query are
          // distinguished by shape: only the duplicate check's `where`
          // includes `licenseNumber`.
          findFirst: jest
            .fn()
            .mockImplementation(({ where }: { where: Record<string, unknown> }) => {
              if ('licenseNumber' in where) {
                return Promise.resolve('duplicateDriver' in opts ? opts.duplicateDriver : null);
              }
              return Promise.resolve(driverRow);
            }),
          create: jest.fn().mockResolvedValue(driverRow),
          update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
            ...driverRow,
            ...data,
          })),
        },
      };

      const prisma = {
        withTenantTransaction: jest
          .fn()
          .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
      };

      const audit = { record: jest.fn().mockResolvedValue(undefined) };
      const eligibility = {
        checkActivationReadiness: jest.fn(),
        recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }),
      };

      const service = new CarrierService(prisma as never, audit as never, eligibility as never);
      return { service, tx, audit, driverRow, carrierRow };
    }

    describe('addDriver — duplicate license guard', () => {
      it('rejects a duplicate license number among active drivers of the same carrier', async () => {
        const { service, tx } = buildDriverService({
          duplicateDriver: { id: 'other-driver' },
        });

        await expect(
          service.addDriver(
            ORG_ID,
            CARRIER_ID,
            { firstName: 'New', lastName: 'Driver', phone: '555-0101', licenseNumber: 'D123' },
            ACTING_USER,
          ),
        ).rejects.toThrow(ConflictError);
        expect(tx.driver.create).not.toHaveBeenCalled();
      });

      it('allows creation when no other active driver has that license number', async () => {
        const { service, tx } = buildDriverService({ duplicateDriver: null });

        await service.addDriver(
          ORG_ID,
          CARRIER_ID,
          { firstName: 'New', lastName: 'Driver', phone: '555-0101', licenseNumber: 'D123' },
          ACTING_USER,
        );

        expect(tx.driver.create).toHaveBeenCalled();
      });
    });

    describe('updateDriver', () => {
      it('applies field changes and audits a field_changes diff against Driver, not Carrier', async () => {
        const { service, tx, audit } = buildDriverService({});

        await service.updateDriver(
          ORG_ID,
          CARRIER_ID,
          DRIVER_ID,
          { phone: '555-9999' },
          ACTING_USER,
        );

        expect(tx.driver.update).toHaveBeenCalledWith({
          where: { id: DRIVER_ID },
          data: { phone: '555-9999' },
        });
        expect(audit.record).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({
            action: 'Driver Updated',
            entityType: 'Driver',
            entityId: DRIVER_ID,
            previousValue: {
              field_changes: [{ field: 'phone', previous: '555-0100', new: '555-9999' }],
            },
            actorUserId: ACTING_USER,
          }),
        );
      });

      it('does not audit when no field actually changes', async () => {
        const { service, audit } = buildDriverService({});

        await service.updateDriver(
          ORG_ID,
          CARRIER_ID,
          DRIVER_ID,
          { phone: '555-0100' },
          ACTING_USER,
        );

        expect(audit.record).not.toHaveBeenCalled();
      });

      it('rejects a duplicate license number on edit, excluding the driver being edited', async () => {
        const { service, tx } = buildDriverService({
          duplicateDriver: { id: 'other-driver' },
        });

        await expect(
          service.updateDriver(
            ORG_ID,
            CARRIER_ID,
            DRIVER_ID,
            { licenseNumber: 'D123' },
            ACTING_USER,
          ),
        ).rejects.toThrow(ConflictError);
        expect(tx.driver.update).not.toHaveBeenCalled();
      });

      it('scopes the duplicate-license check to exclude the driver being edited', async () => {
        const { service, tx } = buildDriverService({ duplicateDriver: null });

        await service.updateDriver(
          ORG_ID,
          CARRIER_ID,
          DRIVER_ID,
          { licenseNumber: 'D123' },
          ACTING_USER,
        );

        expect(tx.driver.findFirst).toHaveBeenCalledWith({
          where: {
            organizationId: ORG_ID,
            carrierId: CARRIER_ID,
            licenseNumber: 'D123',
            active: true,
            id: { not: DRIVER_ID },
          },
        });
      });

      it('does not block reuse of a license number held only by an inactive driver', async () => {
        // The duplicate-check query itself filters to active:true; a
        // mocked `null` result here models the DB correctly excluding an
        // inactive driver's license from the match.
        const { service, tx } = buildDriverService({ duplicateDriver: null });

        await service.updateDriver(
          ORG_ID,
          CARRIER_ID,
          DRIVER_ID,
          { licenseNumber: 'D999' },
          ACTING_USER,
        );

        expect(tx.driver.update).toHaveBeenCalled();
      });

      it('throws NotFoundError for a driver outside the organization/carrier scope', async () => {
        const { service } = buildDriverService({ driver: null });

        await expect(
          service.updateDriver(
            ORG_ID,
            CARRIER_ID,
            'nonexistent',
            { phone: '555-0101' },
            ACTING_USER,
          ),
        ).rejects.toThrow(NotFoundError);
      });
    });

    describe('deactivateDriver / reactivateDriver', () => {
      it('deactivates an active driver, audits Driver Deactivated with reason', async () => {
        const { service, tx, audit } = buildDriverService({});

        await service.deactivateDriver(ORG_ID, CARRIER_ID, DRIVER_ID, REASON_DTO, ACTING_USER);

        expect(tx.driver.update).toHaveBeenCalledWith({
          where: { id: DRIVER_ID },
          data: { active: false },
        });
        expect(audit.record).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({
            action: 'Driver Deactivated',
            entityType: 'Driver',
            entityId: DRIVER_ID,
            previousValue: { active: true },
            newValue: { active: false },
            reason: 'No longer with the company',
            actorUserId: ACTING_USER,
          }),
        );
      });

      it('rejects deactivating an already-inactive driver', async () => {
        const { service, tx } = buildDriverService({
          driver: { id: DRIVER_ID, organizationId: ORG_ID, carrierId: CARRIER_ID, active: false },
        });

        await expect(
          service.deactivateDriver(ORG_ID, CARRIER_ID, DRIVER_ID, REASON_DTO, ACTING_USER),
        ).rejects.toThrow(BusinessRuleError);
        expect(tx.driver.update).not.toHaveBeenCalled();
      });

      it('rejects an empty reason for deactivateDriver', async () => {
        const { service } = buildDriverService({});

        await expect(
          service.deactivateDriver(ORG_ID, CARRIER_ID, DRIVER_ID, { reason: '   ' }, ACTING_USER),
        ).rejects.toThrow(BusinessRuleError);
      });

      it('reactivates an inactive driver, audits Driver Reactivated with reason', async () => {
        const { service, tx, audit } = buildDriverService({
          driver: { id: DRIVER_ID, organizationId: ORG_ID, carrierId: CARRIER_ID, active: false },
        });

        await service.reactivateDriver(ORG_ID, CARRIER_ID, DRIVER_ID, REASON_DTO, ACTING_USER);

        expect(tx.driver.update).toHaveBeenCalledWith({
          where: { id: DRIVER_ID },
          data: { active: true },
        });
        expect(audit.record).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({
            action: 'Driver Reactivated',
            entityType: 'Driver',
            entityId: DRIVER_ID,
            previousValue: { active: false },
            newValue: { active: true },
            reason: 'No longer with the company',
          }),
        );
      });

      it('rejects reactivating an already-active driver', async () => {
        const { service, tx } = buildDriverService({});

        await expect(
          service.reactivateDriver(ORG_ID, CARRIER_ID, DRIVER_ID, REASON_DTO, ACTING_USER),
        ).rejects.toThrow(BusinessRuleError);
        expect(tx.driver.update).not.toHaveBeenCalled();
      });

      it('rejects an empty reason for reactivateDriver', async () => {
        const { service } = buildDriverService({
          driver: { id: DRIVER_ID, organizationId: ORG_ID, carrierId: CARRIER_ID, active: false },
        });

        await expect(
          service.reactivateDriver(ORG_ID, CARRIER_ID, DRIVER_ID, { reason: '' }, ACTING_USER),
        ).rejects.toThrow(BusinessRuleError);
      });

      it.each(['deactivateDriver', 'reactivateDriver'] as const)(
        'throws NotFoundError for %s on a driver outside the organization/carrier scope',
        async (method) => {
          const { service } = buildDriverService({ driver: null });

          await expect(
            service[method](ORG_ID, CARRIER_ID, 'nonexistent', REASON_DTO, ACTING_USER),
          ).rejects.toThrow(NotFoundError);
        },
      );

      it('never touches Load or DispatchRecord — deactivating a Driver leaves historical dispatch data untouched', async () => {
        const { service, tx } = buildDriverService({});

        // The local tx mock in this describe block only defines `carrier`
        // and `driver` tables. deactivateDriver() resolving without a
        // runtime error here is itself proof its transaction body never
        // references tx.load/dispatchRecord/etc — DispatchRecord's
        // driverName/driverPhone/sourceDriverId snapshot fields are
        // structurally untouched by this method.
        await expect(
          service.deactivateDriver(ORG_ID, CARRIER_ID, DRIVER_ID, REASON_DTO, ACTING_USER),
        ).resolves.toBeDefined();
        expect(Object.keys(tx)).toEqual(['carrier', 'driver']);
      });
    });
  });
});
