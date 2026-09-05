import { CarrierPaymentService } from './carrier-payment.service';
import {
  BusinessRuleError,
  InvalidTransitionError,
  NotFoundError,
  PermissionError,
  SelfReviewForbiddenError,
} from '../../../common/errors/app-error';

const ORG_ID = 'org-1';
const LOAD_ID = 'load-1';
const PAYMENT_ID = 'cp-1';
const PREPARER_ID = 'user-preparer';
const APPROVER_ID = 'user-approver';

function buildService(
  opts: {
    load?: Record<string, unknown> | null;
    payment?: Record<string, unknown> | null;
  } = {},
) {
  const paymentRecord = {
    id: PAYMENT_ID,
    organizationId: ORG_ID,
    loadId: LOAD_ID,
    carrierId: 'carrier-1',
    amount: '500.00',
    paymentType: 'DEPOSIT',
    status: 'DRAFT',
    preparedByUserId: PREPARER_ID,
    method: 'ACH',
    referenceNumber: 'REF-1',
    carrier: { legalName: 'Acme Trucking' },
    load: { loadNumber: 'LOAD-000001' },
    ...(opts.payment ?? {}),
  };

  const tx = {
    load: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          'load' in opts
            ? opts.load
            : { id: LOAD_ID, status: 'DELIVERED', assignedCarrierId: 'carrier-1' },
        ),
    },
    carrierPayment: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: PAYMENT_ID, ...data })),
      findFirst: jest
        .fn()
        .mockResolvedValue('payment' in opts && opts.payment === null ? null : paymentRecord),
      update: jest.fn().mockImplementation(({ data }) => ({ ...paymentRecord, ...data })),
      findMany: jest.fn().mockResolvedValue([paymentRecord]),
    },
    chargeLineItem: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    documentTypeDefinition: {
      findFirst: jest.fn().mockResolvedValue({ id: 'doctype-settlement', code: 'SETTLEMENT' }),
    },
    document: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const storage = { buildDocumentKey: jest.fn().mockReturnValue('org_org-1/documents/doc-1') };
  const settlementQueue = { add: jest.fn().mockResolvedValue(undefined) };

  const service = new CarrierPaymentService(
    prisma as never,
    audit as never,
    storage as never,
    settlementQueue as never,
  );

  return { service, tx, audit, storage, settlementQueue };
}

describe('CarrierPaymentService.create — Workflow 9 §9.1-9.2', () => {
  it('creates a DRAFT payment against an eligible (Delivered+) Load with an assigned Carrier', async () => {
    const { service, audit } = buildService();

    const payment = await service.create(
      ORG_ID,
      LOAD_ID,
      { paymentType: 'DEPOSIT', amount: '500.00' },
      PREPARER_ID,
    );

    expect(payment.status).toBe('DRAFT');
    expect(payment.carrierId).toBe('carrier-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Carrier Payment Created — Draft' }),
    );
  });

  it('rejects a Load that has not yet reached Delivered', async () => {
    const { service } = buildService({
      load: { id: LOAD_ID, status: 'DISPATCHED', assignedCarrierId: 'carrier-1' },
    });

    await expect(
      service.create(ORG_ID, LOAD_ID, { paymentType: 'DEPOSIT', amount: '500.00' }, PREPARER_ID),
    ).rejects.toThrow(BusinessRuleError);
  });

  // Cancel Load workflow regression — CANCELLED is not in the ['DELIVERED',
  // 'CLOSED'] eligibility list, so a cancelled Load is never treated as
  // operationally eligible for a Carrier Payment.
  it('rejects a CANCELLED Load — never treated as operationally eligible', async () => {
    const { service } = buildService({
      load: { id: LOAD_ID, status: 'CANCELLED', assignedCarrierId: 'carrier-1' },
    });

    await expect(
      service.create(ORG_ID, LOAD_ID, { paymentType: 'DEPOSIT', amount: '500.00' }, PREPARER_ID),
    ).rejects.toThrow(BusinessRuleError);
  });

  it("Accessorial Charges regression — never persists a computed value into `amount`; the preparer's typed amount is stored verbatim", async () => {
    const { service, tx } = buildService({
      load: {
        id: LOAD_ID,
        status: 'DELIVERED',
        assignedCarrierId: 'carrier-1',
        carrierRate: '1500.00',
      },
    });
    tx.chargeLineItem.findMany.mockResolvedValue([
      { side: 'CARRIER', source: 'ADJUSTMENT', amount: '200.00' },
    ]);

    await service.create(
      ORG_ID,
      LOAD_ID,
      { paymentType: 'DEPOSIT', amount: '500.00' },
      PREPARER_ID,
    );

    expect(tx.carrierPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: '500.00' }) }),
    );
  });

  it('surfaces remainingCarrierBalance (carrierRate + carrier-side accessorials - already-Paid) on the created payment, without altering amount', async () => {
    const { service, tx } = buildService({
      load: {
        id: LOAD_ID,
        status: 'DELIVERED',
        assignedCarrierId: 'carrier-1',
        carrierRate: '1500.00',
      },
    });
    tx.carrierPayment.findMany.mockResolvedValue([]);
    tx.chargeLineItem.findMany.mockResolvedValue([
      { side: 'CARRIER', source: 'ADJUSTMENT', amount: '200.00' },
    ]);

    const payment = await service.create(
      ORG_ID,
      LOAD_ID,
      { paymentType: 'DEPOSIT', amount: '500.00' },
      PREPARER_ID,
    );

    expect(payment.remainingCarrierBalance).toBe('1700.00');
    expect(payment.amount).toBe('500.00');
  });

  it('Accessorial Charges regression — a Load with zero carrier accessorials produces the exact same remainingCarrierBalance as before this feature existed', async () => {
    const { service } = buildService({
      load: {
        id: LOAD_ID,
        status: 'DELIVERED',
        assignedCarrierId: 'carrier-1',
        carrierRate: '1500.00',
      },
    });
    // chargeLineItem.findMany defaults to [] via buildService — no override.

    const payment = await service.create(
      ORG_ID,
      LOAD_ID,
      { paymentType: 'DEPOSIT', amount: '500.00' },
      PREPARER_ID,
    );

    expect(payment.remainingCarrierBalance).toBe('1500.00');
  });
});

describe('CarrierPaymentService.getRemainingBalance — Accessorial Charges pre-creation balance preview', () => {
  it('$700 carrierRate + $150 carrier Detention accessorial = $850 remaining', async () => {
    const { service, tx } = buildService({
      load: {
        id: LOAD_ID,
        status: 'DELIVERED',
        assignedCarrierId: 'carrier-1',
        carrierRate: '700.00',
      },
    });
    tx.carrierPayment.findMany.mockResolvedValue([]);
    tx.chargeLineItem.findMany.mockResolvedValue([
      { side: 'CARRIER', source: 'ADJUSTMENT', amount: '150.00' },
    ]);

    const balance = await service.getRemainingBalance(ORG_ID, LOAD_ID, ['ACCOUNTING']);

    expect(balance).toEqual({
      carrierRate: '700.00',
      carrierAccessorialsTotal: '150.00',
      totalPaid: '0.00',
      remainingCarrierBalance: '850.00',
    });
    expect(tx.chargeLineItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          loadId: LOAD_ID,
          side: 'CARRIER',
          source: 'ADJUSTMENT',
        }),
      }),
    );
  });

  it('$700 carrierRate + $150 carrier Detention − $300 already Paid = $550 remaining', async () => {
    const { service, tx } = buildService({
      load: {
        id: LOAD_ID,
        status: 'DELIVERED',
        assignedCarrierId: 'carrier-1',
        carrierRate: '700.00',
      },
    });
    tx.carrierPayment.findMany.mockResolvedValue([
      { status: 'PAID', amount: '300.00' },
      { status: 'DRAFT', amount: '9999.00' }, // non-PAID rows must never count
    ]);
    tx.chargeLineItem.findMany.mockResolvedValue([
      { side: 'CARRIER', source: 'ADJUSTMENT', amount: '150.00' },
    ]);

    const balance = await service.getRemainingBalance(ORG_ID, LOAD_ID, ['ACCOUNTING']);

    expect(balance.totalPaid).toBe('300.00');
    expect(balance.remainingCarrierBalance).toBe('550.00');
  });

  it('a CUSTOMER-side $150 charge does not affect the carrier balance', async () => {
    const { service, tx } = buildService({
      load: {
        id: LOAD_ID,
        status: 'DELIVERED',
        assignedCarrierId: 'carrier-1',
        carrierRate: '700.00',
      },
    });
    tx.carrierPayment.findMany.mockResolvedValue([]);
    // The query itself is scoped to side='CARRIER' (asserted above) — this
    // simulates what a correctly-scoped query would return: nothing, since
    // a $150 CUSTOMER-side charge would never match that filter.
    tx.chargeLineItem.findMany.mockResolvedValue([]);

    const balance = await service.getRemainingBalance(ORG_ID, LOAD_ID, ['ACCOUNTING']);

    expect(balance.carrierAccessorialsTotal).toBe('0.00');
    expect(balance.remainingCarrierBalance).toBe('700.00');
  });

  it('Accessorial Charges regression — no carrier accessorials produces the same balance as the pre-existing carrierRate-only figure', async () => {
    const { service } = buildService({
      load: {
        id: LOAD_ID,
        status: 'DELIVERED',
        assignedCarrierId: 'carrier-1',
        carrierRate: '700.00',
      },
    });
    // chargeLineItem.findMany and carrierPayment.findMany default to []/[paymentRecord] via buildService.

    const balance = await service.getRemainingBalance(ORG_ID, LOAD_ID, ['ACCOUNTING']);

    expect(balance.remainingCarrierBalance).toBe('700.00');
  });

  it("is tenant-scoped — every query is filtered by the caller's organizationId", async () => {
    const { service, tx } = buildService({
      load: {
        id: LOAD_ID,
        status: 'DELIVERED',
        assignedCarrierId: 'carrier-1',
        carrierRate: '700.00',
      },
    });

    await service.getRemainingBalance(ORG_ID, LOAD_ID, ['ACCOUNTING']);

    expect(tx.load.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: LOAD_ID, organizationId: ORG_ID } }),
    );
    expect(tx.carrierPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_ID, loadId: LOAD_ID } }),
    );
    expect(tx.chargeLineItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG_ID, loadId: LOAD_ID }),
      }),
    );
  });

  it('rejects a role without financial view permission (e.g. Dispatcher)', async () => {
    const { service } = buildService();

    await expect(service.getRemainingBalance(ORG_ID, LOAD_ID, ['DISPATCHER'])).rejects.toThrow(
      PermissionError,
    );
  });

  it('allows Operations Manager to view, matching their existing view-only parity on Carrier Payments', async () => {
    const { service } = buildService({
      load: {
        id: LOAD_ID,
        status: 'DELIVERED',
        assignedCarrierId: 'carrier-1',
        carrierRate: '700.00',
      },
    });

    await expect(
      service.getRemainingBalance(ORG_ID, LOAD_ID, ['OPERATIONS_MANAGER']),
    ).resolves.toBeDefined();
  });

  it('returns a null remainingCarrierBalance when the Load has no carrierRate', async () => {
    const { service } = buildService({
      load: { id: LOAD_ID, status: 'DELIVERED', assignedCarrierId: 'carrier-1', carrierRate: null },
    });

    const balance = await service.getRemainingBalance(ORG_ID, LOAD_ID, ['ACCOUNTING']);

    expect(balance.carrierRate).toBeNull();
    expect(balance.remainingCarrierBalance).toBeNull();
  });

  it('throws NotFoundError for a nonexistent Load', async () => {
    const { service } = buildService({ load: null });

    await expect(
      service.getRemainingBalance(ORG_ID, 'nonexistent', ['ACCOUNTING']),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('CarrierPaymentService.submit — Workflow 9 §9.3', () => {
  it('transitions DRAFT -> PENDING_APPROVAL when method/reference are present', async () => {
    const { service, audit } = buildService();

    const payment = await service.submit(ORG_ID, PAYMENT_ID, PREPARER_ID);

    expect(payment.status).toBe('PENDING_APPROVAL');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Carrier Payment Submitted for Approval' }),
    );
  });

  it('rejects submission when method/reference are missing', async () => {
    const { service } = buildService({
      payment: {
        id: PAYMENT_ID,
        status: 'DRAFT',
        preparedByUserId: PREPARER_ID,
        method: null,
        referenceNumber: null,
      },
    });

    await expect(service.submit(ORG_ID, PAYMENT_ID, PREPARER_ID)).rejects.toThrow(
      BusinessRuleError,
    );
  });
});

describe('CarrierPaymentService.approve/reject — Workflow 9 §9.4', () => {
  it('approves a payment submitted by a different user', async () => {
    const { service, audit } = buildService({
      payment: { id: PAYMENT_ID, status: 'PENDING_APPROVAL', preparedByUserId: PREPARER_ID },
    });

    const payment = await service.approve(ORG_ID, PAYMENT_ID, APPROVER_ID);

    expect(payment.status).toBe('APPROVED');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Carrier Payment Approved' }),
    );
  });

  it('blocks self-approval', async () => {
    const { service } = buildService({
      payment: { id: PAYMENT_ID, status: 'PENDING_APPROVAL', preparedByUserId: PREPARER_ID },
    });

    await expect(service.approve(ORG_ID, PAYMENT_ID, PREPARER_ID)).rejects.toThrow(
      SelfReviewForbiddenError,
    );
  });

  it('rejection returns the payment to DRAFT with the reason recorded, no separate terminal state', async () => {
    const { service, audit } = buildService({
      payment: { id: PAYMENT_ID, status: 'PENDING_APPROVAL', preparedByUserId: PREPARER_ID },
    });

    const payment = await service.reject(
      ORG_ID,
      PAYMENT_ID,
      { reason: 'Amount looks wrong' },
      APPROVER_ID,
    );

    expect(payment.status).toBe('DRAFT');
    expect(payment.lastRejectionReason).toBe('Amount looks wrong');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Carrier Payment Rejected' }),
    );
  });

  it('blocks self-rejection the same as self-approval', async () => {
    const { service } = buildService({
      payment: { id: PAYMENT_ID, status: 'PENDING_APPROVAL', preparedByUserId: PREPARER_ID },
    });

    await expect(service.reject(ORG_ID, PAYMENT_ID, { reason: 'x' }, PREPARER_ID)).rejects.toThrow(
      SelfReviewForbiddenError,
    );
  });
});

describe('CarrierPaymentService.markPaid — Workflow 9 §9.6/§9.8', () => {
  it('transitions APPROVED -> PAID and generates a settlement document', async () => {
    const { service, tx, audit, settlementQueue } = buildService({
      payment: {
        id: PAYMENT_ID,
        status: 'APPROVED',
        preparedByUserId: PREPARER_ID,
        carrier: { legalName: 'Acme Trucking' },
        load: { loadNumber: 'LOAD-000001' },
      },
    });

    const payment = await service.markPaid(ORG_ID, PAYMENT_ID, {}, PREPARER_ID);

    expect(payment.status).toBe('PAID');
    expect(tx.document.create).toHaveBeenCalledTimes(1);
    expect(settlementQueue.add).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Carrier Payment Paid' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Settlement Document Generated' }),
    );
  });

  it('rejects marking a non-Approved payment as Paid', async () => {
    const { service } = buildService({ payment: { id: PAYMENT_ID, status: 'DRAFT' } });

    await expect(service.markPaid(ORG_ID, PAYMENT_ID, {}, PREPARER_ID)).rejects.toThrow(
      InvalidTransitionError,
    );
  });
});

describe('CarrierPaymentService view permissions', () => {
  it('blocks Dispatcher from viewing', async () => {
    const { service } = buildService();
    await expect(service.findById(ORG_ID, PAYMENT_ID, ['DISPATCHER'])).rejects.toThrow(
      PermissionError,
    );
  });

  it('allows Accounting to view', async () => {
    const { service } = buildService();
    const payment = await service.findById(ORG_ID, PAYMENT_ID, ['ACCOUNTING']);
    expect(payment.id).toBe(PAYMENT_ID);
  });

  it('throws NotFoundError for a nonexistent payment', async () => {
    const { service } = buildService({ payment: null });
    await expect(service.findById(ORG_ID, PAYMENT_ID, ['ADMIN'])).rejects.toThrow(NotFoundError);
  });
});
