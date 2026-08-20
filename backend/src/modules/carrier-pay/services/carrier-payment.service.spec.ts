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
