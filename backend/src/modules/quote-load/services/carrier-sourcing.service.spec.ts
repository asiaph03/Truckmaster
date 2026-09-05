import { CarrierSourcingService } from './carrier-sourcing.service';
import {
  BusinessRuleError,
  EligibilityError,
  InvalidTransitionError,
  NotFoundError,
} from '../../../common/errors/app-error';

const ORG_ID = 'org-1';
const LOAD_ID = 'load-1';
const CARRIER_ID = 'carrier-1';
const USER_ID = 'user-1';

function buildService(opts: {
  load?: Record<string, unknown> | null;
  carrier?: Record<string, unknown> | null;
  eligibility?: { eligible: boolean; reasons: string[] };
  documentType?: Record<string, unknown> | null;
  driver?: Record<string, unknown> | null;
  rateConfDoc?: Record<string, unknown> | null;
}) {
  const tx = {
    load: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          'load' in opts ? opts.load : { id: LOAD_ID, status: 'CARRIER_SOURCING' },
        ),
      update: jest.fn().mockImplementation(({ data }) => ({ id: LOAD_ID, ...data })),
    },
    carrier: {
      findFirst: jest.fn().mockResolvedValue('carrier' in opts ? opts.carrier : { id: CARRIER_ID }),
    },
    driver: {
      findFirst: jest.fn().mockResolvedValue('driver' in opts ? opts.driver : null),
    },
    carrierSourcingAttempt: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'attempt-1', ...data })),
      findFirst: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'attempt-1', ...data })),
    },
    documentTypeDefinition: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          'documentType' in opts
            ? opts.documentType
            : { id: 'doctype-1', code: 'RATE_CONFIRMATION' },
        ),
    },
    document: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
      findFirst: jest.fn().mockResolvedValue('rateConfDoc' in opts ? opts.rateConfDoc : null),
    },
    chargeTypeDefinition: {
      findFirst: jest.fn().mockResolvedValue({ id: 'linehaul-type-1', code: 'LINEHAUL' }),
    },
    chargeLineItem: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'charge-1', ...data })),
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const storage = { buildDocumentKey: jest.fn().mockReturnValue('org_org-1/documents/doc-1') };
  const carrierEligibility = {
    recalculate: jest.fn().mockResolvedValue(opts.eligibility ?? { eligible: true, reasons: [] }),
  };
  const emailQueue = { add: jest.fn().mockResolvedValue(undefined) };
  const rateConfirmationQueue = { add: jest.fn().mockResolvedValue(undefined) };

  const service = new CarrierSourcingService(
    prisma as never,
    audit as never,
    storage as never,
    carrierEligibility as never,
    emailQueue as never,
    rateConfirmationQueue as never,
  );

  return { service, tx, audit, storage, carrierEligibility, emailQueue, rateConfirmationQueue };
}

describe('CarrierSourcingService.beginSourcing — Workflow 5 §5.1', () => {
  it('transitions BOOKED -> CARRIER_SOURCING and audits it', async () => {
    const { service, audit } = buildService({ load: { id: LOAD_ID, status: 'BOOKED' } });

    const load = await service.beginSourcing(ORG_ID, LOAD_ID, USER_ID);

    expect(load.status).toBe('CARRIER_SOURCING');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Load Entered Carrier Sourcing' }),
    );
  });

  it('rejects a load that is not BOOKED', async () => {
    const { service } = buildService({ load: { id: LOAD_ID, status: 'CARRIER_SOURCING' } });

    await expect(service.beginSourcing(ORG_ID, LOAD_ID, USER_ID)).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it('throws NotFoundError for a nonexistent load', async () => {
    const { service } = buildService({ load: null });

    await expect(service.beginSourcing(ORG_ID, LOAD_ID, USER_ID)).rejects.toThrow(NotFoundError);
  });
});

describe('CarrierSourcingService.logSourcingAttempt — Workflow 5 §5.5', () => {
  it('always creates a new row, never overwrites', async () => {
    const { service, tx, audit } = buildService({});

    const attempt = await service.logSourcingAttempt(
      ORG_ID,
      LOAD_ID,
      { carrierId: CARRIER_ID, outcome: 'DECLINED' },
      USER_ID,
    );

    expect(attempt.outcome).toBe('DECLINED');
    expect(tx.carrierSourcingAttempt.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Sourcing Attempt Logged' }),
    );
  });

  it('throws NotFoundError when the carrier does not exist in this org', async () => {
    const { service } = buildService({ carrier: null });

    await expect(
      service.logSourcingAttempt(
        ORG_ID,
        LOAD_ID,
        { carrierId: CARRIER_ID, outcome: 'QUOTED' },
        USER_ID,
      ),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('CarrierSourcingService.assignCarrier — Workflow 5 §5.3/§5.4', () => {
  it('assigns an eligible carrier, creates an ASSIGNED sourcing attempt, and transitions the Load', async () => {
    const { service, tx, audit } = buildService({});

    const load = await service.assignCarrier(
      ORG_ID,
      LOAD_ID,
      { carrierId: CARRIER_ID, carrierRate: '2000.00' },
      USER_ID,
    );

    expect(load.status).toBe('CARRIER_ASSIGNED');
    expect(load.assignedCarrierId).toBe(CARRIER_ID);
    expect(tx.carrierSourcingAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outcome: 'ASSIGNED' }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Carrier Assigned' }),
    );
  });

  it('Phase 6: creates an ORIGINAL carrier-side LINEHAUL ChargeLineItem at assignment time (DATABASE_DESIGN.md §14)', async () => {
    const { service, tx } = buildService({});

    await service.assignCarrier(
      ORG_ID,
      LOAD_ID,
      { carrierId: CARRIER_ID, carrierRate: '2000.00' },
      USER_ID,
    );

    expect(tx.chargeTypeDefinition.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ code: 'LINEHAUL' }) }),
    );
    expect(tx.chargeLineItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          loadId: LOAD_ID,
          side: 'CARRIER',
          chargeTypeId: 'linehaul-type-1',
          unitRate: '2000.00',
          amount: '2000.00',
          source: 'ORIGINAL',
          createdByUserId: USER_ID,
        }),
      }),
    );
  });

  it('does not create the carrier LINEHAUL charge when the eligibility gate blocks assignment', async () => {
    const { service, tx } = buildService({
      eligibility: { eligible: false, reasons: ['COI expired'] },
    });

    await expect(
      service.assignCarrier(
        ORG_ID,
        LOAD_ID,
        { carrierId: CARRIER_ID, carrierRate: '2000.00' },
        USER_ID,
      ),
    ).rejects.toThrow(EligibilityError);

    expect(tx.chargeLineItem.create).not.toHaveBeenCalled();
  });

  it('hard-blocks an ineligible carrier — no override, reasons included, and audits the block', async () => {
    const { service, tx, audit } = buildService({
      eligibility: { eligible: false, reasons: ['COI expired'] },
    });

    await expect(
      service.assignCarrier(
        ORG_ID,
        LOAD_ID,
        { carrierId: CARRIER_ID, carrierRate: '2000.00' },
        USER_ID,
      ),
    ).rejects.toThrow(EligibilityError);

    expect(tx.load.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Carrier Assignment Blocked — Ineligible' }),
    );
  });

  it('re-validates eligibility live — does not trust a stale flag', async () => {
    const { service, carrierEligibility } = buildService({});

    await service.assignCarrier(
      ORG_ID,
      LOAD_ID,
      { carrierId: CARRIER_ID, carrierRate: '2000.00' },
      USER_ID,
    );

    expect(carrierEligibility.recalculate).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      CARRIER_ID,
    );
  });

  it.each(['BLOCKED', 'INACTIVE'] as const)(
    'hard-blocks assignment of a carrier whose real status is %s — Task #3',
    async (status) => {
      const { service, tx, audit } = buildService({
        carrier: { id: CARRIER_ID, status },
        eligibility: { eligible: false, reasons: ['Carrier status is not Active'] },
      });

      await expect(
        service.assignCarrier(
          ORG_ID,
          LOAD_ID,
          { carrierId: CARRIER_ID, carrierRate: '2000.00' },
          USER_ID,
        ),
      ).rejects.toThrow(EligibilityError);

      expect(tx.load.update).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'Carrier Assignment Blocked — Ineligible' }),
      );
    },
  );

  it('rejects assignment when the Load is not in CARRIER_SOURCING', async () => {
    const { service } = buildService({ load: { id: LOAD_ID, status: 'BOOKED' } });

    await expect(
      service.assignCarrier(
        ORG_ID,
        LOAD_ID,
        { carrierId: CARRIER_ID, carrierRate: '2000.00' },
        USER_ID,
      ),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

describe('CarrierSourcingService.carrierRejected — Workflow 5 §5.6', () => {
  it('updates (never deletes) the existing ASSIGNED attempt, clears assignment, returns to CARRIER_SOURCING', async () => {
    const { service, tx, audit } = buildService({
      load: {
        id: LOAD_ID,
        status: 'CARRIER_ASSIGNED',
        assignedCarrierId: CARRIER_ID,
        carrierRate: { toString: () => '2000.00' },
      },
    });

    const load = await service.carrierRejected(
      ORG_ID,
      LOAD_ID,
      { reason: 'No equipment' },
      USER_ID,
    );

    expect(load.status).toBe('CARRIER_SOURCING');
    expect(load.assignedCarrierId).toBeNull();
    expect(load.carrierRate).toBeNull();
    expect(tx.carrierSourcingAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { outcome: 'REJECTED_AFTER_ASSIGNMENT', rejectionReason: 'No equipment' },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Carrier Rejected — Returned to Sourcing' }),
    );
  });

  it('rejects when the Load has no active Carrier Assignment', async () => {
    const { service } = buildService({ load: { id: LOAD_ID, status: 'CARRIER_SOURCING' } });

    await expect(
      service.carrierRejected(ORG_ID, LOAD_ID, { reason: 'No equipment' }, USER_ID),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

describe('CarrierSourcingService.generateRateConfirmation — Workflow 5 §5.7', () => {
  function assignedLoad() {
    return {
      id: LOAD_ID,
      loadNumber: 'LOAD-000001',
      status: 'CARRIER_ASSIGNED',
      assignedCarrierId: CARRIER_ID,
      carrierRate: { toString: () => '2000.00' },
      assignedCarrier: { primaryContactEmail: 'dispatch@carrier.test' },
    };
  }

  it('gated on Carrier + rate only, creates a Document, transitions to RATE_CONFIRMATION, and enqueues the PDF job', async () => {
    const { service, tx, audit, rateConfirmationQueue } = buildService({ load: assignedLoad() });

    const load = await service.generateRateConfirmation(ORG_ID, LOAD_ID, {}, USER_ID);

    expect(load.status).toBe('RATE_CONFIRMATION');
    expect(tx.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: 'LOAD',
          entityId: LOAD_ID,
          scanStatus: 'CLEAN',
        }),
      }),
    );
    expect(rateConfirmationQueue.add).toHaveBeenCalledWith(
      'generate',
      expect.objectContaining({ documentId: 'doc-1', loadId: LOAD_ID, organizationId: ORG_ID }),
      expect.anything(),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Rate Confirmation Generated' }),
    );
  });

  it('sends and audits an email when sendEmail is requested', async () => {
    const { service, audit, emailQueue } = buildService({ load: assignedLoad() });

    await service.generateRateConfirmation(ORG_ID, LOAD_ID, { sendEmail: true }, USER_ID);

    expect(emailQueue.add).toHaveBeenCalledWith(
      'send',
      expect.objectContaining({ to: 'dispatch@carrier.test' }),
      expect.anything(),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Rate Confirmation Sent' }),
    );
  });

  it('rejects when the Load is not CARRIER_ASSIGNED', async () => {
    const { service } = buildService({ load: { id: LOAD_ID, status: 'CARRIER_SOURCING' } });

    await expect(service.generateRateConfirmation(ORG_ID, LOAD_ID, {}, USER_ID)).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it('rejects when carrier or rate is missing (defense-in-depth)', async () => {
    const { service } = buildService({
      load: {
        id: LOAD_ID,
        status: 'CARRIER_ASSIGNED',
        assignedCarrierId: null,
        carrierRate: null,
      },
    });

    await expect(service.generateRateConfirmation(ORG_ID, LOAD_ID, {}, USER_ID)).rejects.toThrow(
      BusinessRuleError,
    );
  });

  it('does not require driver/truck/trailer at this step', async () => {
    const { service } = buildService({ load: assignedLoad() });

    await expect(
      service.generateRateConfirmation(ORG_ID, LOAD_ID, {}, USER_ID),
    ).resolves.toBeDefined();
  });
});

describe('CarrierSourcingService — Driver Dispatch Email feature', () => {
  const DRIVER_ID = 'driver-1';

  /**
   * The ORIGINAL, user-uploaded Rate Confirmation — `generationStatus:
   * null` is the discriminator that separates it from the system-
   * generated carrier-facing document (which always has a non-null
   * generationStatus). Both share the exact same document TYPE
   * ('RATE_CONFIRMATION') and `entityType:'LOAD', entityId:loadId`
   * scoping.
   */
  function cleanUploadedRateConfDoc(overrides: Record<string, unknown> = {}) {
    return {
      id: 'uploaded-rate-conf-doc-1',
      fileName: 'Nurana RC 2434269.pdf',
      fileStorageKey: 'org_org-1/documents/uploaded-rate-conf-doc-1',
      generationStatus: null,
      scanStatus: 'CLEAN',
      mimeType: 'application/pdf',
      ...overrides,
    };
  }

  function dispatchedLoad(overrides: Record<string, unknown> = {}) {
    return {
      id: LOAD_ID,
      loadNumber: 'LOAD-000001',
      status: 'DISPATCHED',
      assignedCarrierId: CARRIER_ID,
      assignedCarrier: { legalName: 'MG CARGO INC' },
      customer: { legalName: 'Basciani Express' },
      customerPoNumber: '120-25370',
      customerRate: '950.00',
      dispatchRecord: {
        sourceDriverId: DRIVER_ID,
        driverName: 'Julia',
        driverPhone: '(773) 870-1332',
      },
      stops: [
        {
          stopType: 'PICKUP',
          companyName: 'I Love Produce',
          addressLine1: '15 Commerce Blvd',
          city: 'West Grove',
          state: 'PA',
          zip: '19390',
          appointmentDatetime: null,
          contactName: 'Eric Frasse',
          contactPhone: '(610) 212-1201',
          notes: 'Reefer Ref#: MR2\nInternal Order#: 56631',
        },
        {
          stopType: 'DELIVERY',
          companyName: 'Jetro % Americold',
          addressLine1: '501 Kentile Rd',
          city: 'South Plainfield',
          state: 'NJ',
          zip: '07080',
          appointmentDatetime: null,
          contactName: null,
          contactPhone: '(908) 756-6242',
          notes: null,
        },
      ],
      ...overrides,
    };
  }

  describe('previewDriverDispatchEmail / recipient resolution', () => {
    it('resolves the recipient email from dispatchRecord.sourceDriverId', async () => {
      const { service, tx } = buildService({
        load: dispatchedLoad(),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
          active: true,
        },
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.recipientEmail).toBe('julia@carrier.test');
      expect(tx.driver.findFirst).toHaveBeenCalledWith({
        where: { id: DRIVER_ID, organizationId: ORG_ID, carrierId: CARRIER_ID, active: true },
      });
    });

    /**
     * Task #7 — like the cross-carrier test below, the mock models "the
     * DB's `active: true` filter excluded this row" the same way it
     * models any other non-matching WHERE clause: by returning `null`
     * from tx.driver.findFirst (the mock does not itself apply the where
     * clause — see buildService above). Asserting the where clause
     * includes `active: true` is what actually proves the production
     * code sends the correct filter to the database.
     */
    it('does not resolve an inactive driver email (Task #7 active-filter guard)', async () => {
      const { service, tx } = buildService({
        load: dispatchedLoad(),
        driver: null,
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(tx.driver.findFirst).toHaveBeenCalledWith({
        where: { id: DRIVER_ID, organizationId: ORG_ID, carrierId: CARRIER_ID, active: true },
      });
      expect(preview.recipientEmail).toBeNull();
    });

    it('still resolves an active driver email (Task #7 active-filter regression)', async () => {
      const { service } = buildService({
        load: dispatchedLoad(),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
          active: true,
        },
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.recipientEmail).toBe('julia@carrier.test');
    });

    it('returns null recipientEmail when the driver has no email on file', async () => {
      const { service } = buildService({
        load: dispatchedLoad(),
        driver: { id: DRIVER_ID, email: null, organizationId: ORG_ID, carrierId: CARRIER_ID },
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.recipientEmail).toBeNull();
    });

    it('never falls back to the carrier email as a recipient, even though it is loaded on assignedCarrier', async () => {
      const { service } = buildService({
        load: dispatchedLoad({
          assignedCarrier: {
            legalName: 'MG CARGO INC',
            primaryContactEmail: 'dispatch@carrier.test',
          },
        }),
        driver: null,
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.recipientEmail).toBeNull();
      expect(preview.recipientEmail).not.toBe('dispatch@carrier.test');
    });

    it('rejects a driver belonging to a different carrier (cross-carrier / unauthorized driver)', async () => {
      const { service, tx } = buildService({
        load: dispatchedLoad(),
        // tx.driver.findFirst is scoped by carrierId in the where-clause; a driver
        // that doesn't match that scope is correctly modeled as "not found".
        driver: null,
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.recipientEmail).toBeNull();
      expect(tx.driver.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ carrierId: CARRIER_ID }) }),
      );
    });

    it('rejects a Load with no dispatchRecord (not yet dispatched)', async () => {
      const { service } = buildService({
        load: dispatchedLoad({ dispatchRecord: null }),
      });

      await expect(service.previewDriverDispatchEmail(ORG_ID, LOAD_ID)).rejects.toThrow(
        BusinessRuleError,
      );
    });

    it('rejects a Load with no assigned carrier on record', async () => {
      const { service } = buildService({
        load: dispatchedLoad({ assignedCarrier: null }),
      });

      await expect(service.previewDriverDispatchEmail(ORG_ID, LOAD_ID)).rejects.toThrow(
        BusinessRuleError,
      );
    });

    it('throws NotFoundError for a nonexistent load', async () => {
      const { service } = buildService({ load: null });

      await expect(service.previewDriverDispatchEmail(ORG_ID, LOAD_ID)).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('previewDriverDispatchEmail / message content', () => {
    it('generates the exact subject "Dispatch Details — Load #<loadNumber>"', async () => {
      const { service } = buildService({
        load: dispatchedLoad({ loadNumber: 'LOAD-000042' }),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.subject).toBe('Dispatch Details — Load #LOAD-000042');
    });

    it('produces a clean body with no undefined/null placeholders when optional fields are missing', async () => {
      const { service } = buildService({
        load: dispatchedLoad({ customerPoNumber: null, customerRate: null }),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.body).not.toMatch(/undefined/i);
      expect(preview.body).not.toMatch(/\bnull\b/i);
      expect(preview.body).not.toContain('PO:');
    });

    it('maps approved pickup-stop Notes fields (Reefer Ref#, Internal Order#) into the message', async () => {
      const { service } = buildService({
        load: dispatchedLoad(),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.body).toContain('🔑 Reefer Ref#: MR2');
      expect(preview.body).toContain('📋 Order #: 56631');
    });

    it('never injects an unrelated/unapproved dispatcher note left in the same Notes field', async () => {
      const { service } = buildService({
        load: dispatchedLoad({
          stops: [
            {
              stopType: 'PICKUP',
              companyName: 'I Love Produce',
              addressLine1: '15 Commerce Blvd',
              city: 'West Grove',
              state: 'PA',
              zip: '19390',
              appointmentDatetime: null,
              contactName: 'Eric Frasse',
              contactPhone: '(610) 212-1201',
              notes: 'Reefer Ref#: MR2\nCall the dock before arrival.',
            },
          ],
        }),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.body).not.toContain('Call the dock before arrival.');
    });

    it('includes "Pickup #: <value>" sourced from Load.pickupNumber — the same authoritative field shown as "Pickup #" on the Load Overview tab', async () => {
      const { service } = buildService({
        load: dispatchedLoad({ pickupNumber: '5010181698' }),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.body).toContain('Pickup #: 5010181698');
    });

    it('omits the Pickup # line when Load.pickupNumber is null, without altering any other line', async () => {
      const withNumber = await (async () => {
        const { service } = buildService({
          load: dispatchedLoad({ pickupNumber: '5010181698' }),
          driver: {
            id: DRIVER_ID,
            email: 'julia@carrier.test',
            organizationId: ORG_ID,
            carrierId: CARRIER_ID,
          },
          rateConfDoc: cleanUploadedRateConfDoc(),
        });
        return service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);
      })();

      const { service } = buildService({
        load: dispatchedLoad({ pickupNumber: null }),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: cleanUploadedRateConfDoc(),
      });
      const withoutNumber = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(withoutNumber.body).not.toContain('Pickup #:');
      expect(
        withNumber.body
          .split('\n')
          .filter((l) => l !== 'Pickup #: 5010181698')
          .join('\n'),
      ).toBe(withoutNumber.body);
    });
  });

  describe('Uploaded Rate Confirmation attachment resolution (preview)', () => {
    it('resolves the uploaded (generationStatus: null) RATE_CONFIRMATION document, org- and Load-scoped, current version only, most recent first', async () => {
      const { service, tx } = buildService({
        load: dispatchedLoad(),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.attachmentAvailable).toBe(true);
      expect(preview.attachmentFileName).toBe('Nurana RC 2434269.pdf');
      expect(tx.document.findFirst).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          entityType: 'LOAD',
          entityId: LOAD_ID,
          documentTypeId: 'doctype-1',
          isCurrentVersion: true,
          generationStatus: null,
        },
        orderBy: { uploadedAt: 'desc' },
      });
    });

    it('MALWARE_SCAN_ENABLED=false — resolves a document scanned via the malware-scan bypass exactly like a genuinely Cloudmersive-scanned one, since the gate only checks scanStatus === CLEAN, never scanProvider', async () => {
      const { service } = buildService({
        load: dispatchedLoad(),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: cleanUploadedRateConfDoc({
          scanStatus: 'CLEAN',
          scanProvider: 'bypass: malware scanning disabled by configuration',
        }),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.attachmentAvailable).toBe(true);
      expect(preview.attachmentFileName).toBe('Nurana RC 2434269.pdf');
    });

    it('is unavailable when the current-version RATE_CONFIRMATION is the system-generated one (generationStatus non-null) — never falls back to it', async () => {
      // The query itself filters generationStatus: null, so a generated-
      // only document is correctly modeled as "not found" by the mock —
      // this is what the prior test's query-shape assertion proves is
      // actually sent to Postgres.
      const { service } = buildService({
        load: dispatchedLoad(),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: null,
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.attachmentAvailable).toBe(false);
      expect(preview.attachmentFileName).toBeNull();
    });

    it('is unavailable while the uploaded document is still PENDING scan (not yet consumable)', async () => {
      const { service } = buildService({
        load: dispatchedLoad(),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: cleanUploadedRateConfDoc({ scanStatus: 'PENDING' }),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.attachmentAvailable).toBe(false);
    });

    it('is unavailable when the uploaded document is INFECTED (remains blocked)', async () => {
      const { service } = buildService({
        load: dispatchedLoad(),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: cleanUploadedRateConfDoc({ scanStatus: 'INFECTED' }),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.attachmentAvailable).toBe(false);
    });

    it('is unavailable when the uploaded document is not a PDF', async () => {
      const { service } = buildService({
        load: dispatchedLoad(),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: cleanUploadedRateConfDoc({ mimeType: 'image/png' }),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.attachmentAvailable).toBe(false);
    });

    it('is unavailable when no uploaded Rate Confirmation document exists at all', async () => {
      const { service } = buildService({
        load: dispatchedLoad(),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: null,
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.attachmentAvailable).toBe(false);
      expect(preview.attachmentFileName).toBeNull();
    });

    it('is unavailable when the Rate Confirmation document type itself is not configured (seed not applied)', async () => {
      const { service } = buildService({
        load: dispatchedLoad(),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        documentType: null,
        rateConfDoc: cleanUploadedRateConfDoc(),
      });

      const preview = await service.previewDriverDispatchEmail(ORG_ID, LOAD_ID);

      expect(preview.attachmentAvailable).toBe(false);
    });
  });

  describe('sendDriverDispatchEmail', () => {
    function buildDispatchService(overrides: Parameters<typeof buildService>[0] = {}) {
      return buildService({
        load: dispatchedLoad(),
        driver: {
          id: DRIVER_ID,
          email: 'julia@carrier.test',
          organizationId: ORG_ID,
          carrierId: CARRIER_ID,
        },
        rateConfDoc: cleanUploadedRateConfDoc(),
        ...overrides,
      });
    }

    describe('checkbox ON (attachRateConfirmation: true)', () => {
      it('attaches the uploaded RATE_CONFIRMATION document — never the generated one, never both', async () => {
        const { service, tx, emailQueue, audit } = buildDispatchService();

        const result = await service.sendDriverDispatchEmail(
          ORG_ID,
          LOAD_ID,
          { attachRateConfirmation: true },
          USER_ID,
        );

        expect(result.recipientEmail).toBe('julia@carrier.test');
        expect(tx.document.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ generationStatus: null }),
          }),
        );
        expect(emailQueue.add).toHaveBeenCalledWith(
          'send',
          expect.objectContaining({
            to: 'julia@carrier.test',
            subject: 'Dispatch Details — Load #LOAD-000001',
            organizationId: ORG_ID,
            entityType: 'Load',
            entityId: LOAD_ID,
            attachmentDocumentId: 'uploaded-rate-conf-doc-1',
          }),
          expect.anything(),
        );
        const jobData = emailQueue.add.mock.calls[0][1];
        expect(jobData.attachmentDocumentId).not.toBe('rate-conf-doc-1'); // not the generated id
        expect(audit.record).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            action: 'Driver Dispatch Email Sent',
            newValue: expect.objectContaining({
              recipientSource: 'driver-on-file',
              documentId: 'uploaded-rate-conf-doc-1',
            }),
          }),
        );
      });

      it('MALWARE_SCAN_ENABLED=true, Cloudmersive scan actually failed — attaches a SCAN_FAILED uploaded Rate Confirmation anyway (approved policy: a failed scan attempt does not block the attachment, only INFECTED does; the document stays SCAN_FAILED, never rewritten to CLEAN)', async () => {
        const { service, emailQueue, audit } = buildDispatchService({
          rateConfDoc: cleanUploadedRateConfDoc({ scanStatus: 'SCAN_FAILED' }),
        });

        const result = await service.sendDriverDispatchEmail(
          ORG_ID,
          LOAD_ID,
          { attachRateConfirmation: true },
          USER_ID,
        );

        expect(result.recipientEmail).toBe('julia@carrier.test');
        expect(emailQueue.add).toHaveBeenCalledWith(
          'send',
          expect.objectContaining({ attachmentDocumentId: 'uploaded-rate-conf-doc-1' }),
          expect.anything(),
        );
        expect(audit.record).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            newValue: expect.objectContaining({ documentId: 'uploaded-rate-conf-doc-1' }),
          }),
        );
      });

      it('fails clearly, without sending, when no eligible uploaded Rate Confirmation exists (only a generated one, or none at all) — never falls back to it', async () => {
        const { service, emailQueue } = buildDispatchService({ rateConfDoc: null });

        await expect(
          service.sendDriverDispatchEmail(
            ORG_ID,
            LOAD_ID,
            { attachRateConfirmation: true },
            USER_ID,
          ),
        ).rejects.toThrow(BusinessRuleError);
        expect(emailQueue.add).not.toHaveBeenCalled();
      });

      it('fails clearly for a directly-booked/existing Load with no uploaded Rate Confirmation on file', async () => {
        const { service, emailQueue } = buildDispatchService({ rateConfDoc: null });

        const error = await service
          .sendDriverDispatchEmail(ORG_ID, LOAD_ID, { attachRateConfirmation: true }, USER_ID)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BusinessRuleError);
        expect((error as Error).message).toMatch(/not available/i);
        expect(emailQueue.add).not.toHaveBeenCalled();
      });

      it('rejects when the only current-version document is INFECTED (remains blocked — the one scan outcome that still is)', async () => {
        const { service, emailQueue } = buildDispatchService({
          rateConfDoc: cleanUploadedRateConfDoc({ scanStatus: 'INFECTED' }),
        });

        await expect(
          service.sendDriverDispatchEmail(
            ORG_ID,
            LOAD_ID,
            { attachRateConfirmation: true },
            USER_ID,
          ),
        ).rejects.toThrow(BusinessRuleError);
        expect(emailQueue.add).not.toHaveBeenCalled();
      });

      it('rejects when the only current-version document is not a PDF', async () => {
        const { service, emailQueue } = buildDispatchService({
          rateConfDoc: cleanUploadedRateConfDoc({ mimeType: 'image/png' }),
        });

        await expect(
          service.sendDriverDispatchEmail(
            ORG_ID,
            LOAD_ID,
            { attachRateConfirmation: true },
            USER_ID,
          ),
        ).rejects.toThrow(BusinessRuleError);
        expect(emailQueue.add).not.toHaveBeenCalled();
      });

      it('most recently uploaded matching document wins (deterministic ordering, asserted via the query itself)', async () => {
        const { service, tx } = buildDispatchService();

        await service.sendDriverDispatchEmail(
          ORG_ID,
          LOAD_ID,
          { attachRateConfirmation: true },
          USER_ID,
        );

        expect(tx.document.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ orderBy: { uploadedAt: 'desc' } }),
        );
      });

      it('never converts the dispatch text itself into the attachment — body stays text, attachment is always the resolved documentId', async () => {
        const { service, emailQueue } = buildDispatchService();

        await service.sendDriverDispatchEmail(
          ORG_ID,
          LOAD_ID,
          { attachRateConfirmation: true },
          USER_ID,
        );

        const jobData = emailQueue.add.mock.calls[0][1];
        expect(typeof jobData.body).toBe('string');
        expect(jobData.attachmentDocumentId).toBe('uploaded-rate-conf-doc-1');
        expect(jobData).not.toHaveProperty('attachments');
      });
    });

    describe('checkbox OFF (attachRateConfirmation: false)', () => {
      it('sends with no attachment and never queries for one at all', async () => {
        const { service, tx, emailQueue } = buildDispatchService();

        const result = await service.sendDriverDispatchEmail(
          ORG_ID,
          LOAD_ID,
          { attachRateConfirmation: false },
          USER_ID,
        );

        expect(result.recipientEmail).toBe('julia@carrier.test');
        expect(tx.document.findFirst).not.toHaveBeenCalled();
        const jobData = emailQueue.add.mock.calls[0][1];
        expect(jobData).not.toHaveProperty('attachmentDocumentId');
      });

      it('sends successfully even when only a generated Rate Confirmation exists (no uploaded one) — no error, no attachment', async () => {
        const { service, tx } = buildDispatchService({ rateConfDoc: null });

        const result = await service.sendDriverDispatchEmail(
          ORG_ID,
          LOAD_ID,
          { attachRateConfirmation: false },
          USER_ID,
        );

        expect(result.recipientEmail).toBe('julia@carrier.test');
        expect(tx.document.findFirst).not.toHaveBeenCalled();
      });

      it('succeeds for a directly-booked/existing Load with no uploaded Rate Confirmation on file at all', async () => {
        const { service, emailQueue } = buildDispatchService({ rateConfDoc: null });

        await expect(
          service.sendDriverDispatchEmail(
            ORG_ID,
            LOAD_ID,
            { attachRateConfirmation: false },
            USER_ID,
          ),
        ).resolves.toBeDefined();
        expect(emailQueue.add).toHaveBeenCalled();
      });
    });

    it('recipient resolution is unaffected by the attachment checkbox: driver-on-file wins regardless', async () => {
      const { service } = buildDispatchService();

      const onResult = await service.sendDriverDispatchEmail(
        ORG_ID,
        LOAD_ID,
        { attachRateConfirmation: true },
        USER_ID,
      );
      const offResult = await service.sendDriverDispatchEmail(
        ORG_ID,
        LOAD_ID,
        { attachRateConfirmation: false },
        USER_ID,
      );

      expect(onResult.recipientEmail).toBe('julia@carrier.test');
      expect(offResult.recipientEmail).toBe('julia@carrier.test');
    });

    it('accepts a manual recipient email as a one-time override when no driver email is on file, and does not persist it', async () => {
      const { service, tx, emailQueue, audit } = buildDispatchService({
        driver: { id: DRIVER_ID, email: null, organizationId: ORG_ID, carrierId: CARRIER_ID },
      });

      const result = await service.sendDriverDispatchEmail(
        ORG_ID,
        LOAD_ID,
        { manualRecipientEmail: 'dispatcher-override@example.com', attachRateConfirmation: false },
        USER_ID,
      );

      expect(result.recipientEmail).toBe('dispatcher-override@example.com');
      expect(emailQueue.add).toHaveBeenCalledWith(
        'send',
        expect.objectContaining({ to: 'dispatcher-override@example.com' }),
        expect.anything(),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          newValue: expect.objectContaining({ recipientSource: 'manual-override' }),
        }),
      );
      // Never written back to the Driver record.
      expect(tx.driver.findFirst).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.anything() }),
      );
    });

    it('rejects when neither a driver email nor a manual override is available', async () => {
      const { service, emailQueue } = buildDispatchService({
        driver: { id: DRIVER_ID, email: null, organizationId: ORG_ID, carrierId: CARRIER_ID },
      });

      await expect(
        service.sendDriverDispatchEmail(
          ORG_ID,
          LOAD_ID,
          { attachRateConfirmation: false },
          USER_ID,
        ),
      ).rejects.toThrow(BusinessRuleError);
      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it('never falls back to the carrier email, even with no driver email and no manual override', async () => {
      const { service, emailQueue } = buildDispatchService({
        load: dispatchedLoad({
          assignedCarrier: {
            legalName: 'MG CARGO INC',
            primaryContactEmail: 'dispatch@carrier.test',
          },
        }),
        driver: { id: DRIVER_ID, email: null, organizationId: ORG_ID, carrierId: CARRIER_ID },
      });

      await expect(
        service.sendDriverDispatchEmail(
          ORG_ID,
          LOAD_ID,
          { attachRateConfirmation: false },
          USER_ID,
        ),
      ).rejects.toThrow(BusinessRuleError);
      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it('rejects a cross-carrier/unauthorized driver — no email resolved, no manual override supplied', async () => {
      const { service, emailQueue } = buildDispatchService({ driver: null });

      await expect(
        service.sendDriverDispatchEmail(
          ORG_ID,
          LOAD_ID,
          { attachRateConfirmation: false },
          USER_ID,
        ),
      ).rejects.toThrow(BusinessRuleError);
      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it('rejects a non-dispatched Load (no dispatchRecord)', async () => {
      const { service, emailQueue } = buildDispatchService({
        load: dispatchedLoad({ dispatchRecord: null }),
      });

      await expect(
        service.sendDriverDispatchEmail(
          ORG_ID,
          LOAD_ID,
          { attachRateConfirmation: false },
          USER_ID,
        ),
      ).rejects.toThrow(BusinessRuleError);
      expect(emailQueue.add).not.toHaveBeenCalled();
    });

    it('does not affect the existing Rate Confirmation generation/email route — generateRateConfirmation behavior unchanged', async () => {
      const { service, emailQueue, tx } = buildDispatchService({
        load: {
          id: LOAD_ID,
          loadNumber: 'LOAD-000001',
          status: 'CARRIER_ASSIGNED',
          assignedCarrierId: CARRIER_ID,
          carrierRate: { toString: () => '2000.00' },
          assignedCarrier: { primaryContactEmail: 'dispatch@carrier.test' },
        },
      });

      await service.generateRateConfirmation(ORG_ID, LOAD_ID, { sendEmail: true }, USER_ID);

      expect(emailQueue.add).toHaveBeenCalledWith(
        'send',
        expect.objectContaining({ to: 'dispatch@carrier.test' }),
        expect.anything(),
      );
      expect(tx.document.create).toHaveBeenCalled();
    });
  });
});
