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
  const emailSender = { send: jest.fn().mockResolvedValue(undefined) };
  const rateConfirmationQueue = { add: jest.fn().mockResolvedValue(undefined) };

  const service = new CarrierSourcingService(
    prisma as never,
    audit as never,
    storage as never,
    carrierEligibility as never,
    emailSender as never,
    rateConfirmationQueue as never,
  );

  return { service, tx, audit, storage, carrierEligibility, emailSender, rateConfirmationQueue };
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
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Rate Confirmation Generated' }),
    );
  });

  it('sends and audits an email when sendEmail is requested', async () => {
    const { service, audit, emailSender } = buildService({ load: assignedLoad() });

    await service.generateRateConfirmation(ORG_ID, LOAD_ID, { sendEmail: true }, USER_ID);

    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'dispatch@carrier.test' }),
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
