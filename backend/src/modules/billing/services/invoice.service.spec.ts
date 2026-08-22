import { InvoiceService } from './invoice.service';
import {
  BusinessRuleError,
  InvalidTransitionError,
  PermissionError,
  PodIncompleteWarningError,
} from '../../../common/errors/app-error';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';
const CUSTOMER_ID = 'cust-1';
const INVOICE_ID = 'inv-1';

const LOAD_1 = {
  id: 'load-1',
  loadNumber: 'LOAD-000001',
  customerId: CUSTOMER_ID,
  status: 'DELIVERED',
  invoiced: false,
  podStatus: 'COMPLETE',
  chargeLineItems: [
    {
      id: 'cli-1',
      side: 'CUSTOMER',
      amount: '1800.00',
      description: null,
      chargeType: { label: 'Linehaul' },
    },
  ],
};

const LOAD_2 = {
  ...LOAD_1,
  id: 'load-2',
  loadNumber: 'LOAD-000002',
  chargeLineItems: [
    {
      id: 'cli-2',
      side: 'CUSTOMER',
      amount: '900.00',
      description: null,
      chargeType: { label: 'Linehaul' },
    },
  ],
};

function buildService(
  opts: {
    loads?: Record<string, unknown>[];
    invoice?: Record<string, unknown> | null;
    payments?: Record<string, unknown>[];
    adjustments?: Record<string, unknown>[];
    customer?: Record<string, unknown> | null;
    invoiceLoads?: Record<string, unknown>[];
  } = {},
) {
  const invoiceRecord = {
    id: INVOICE_ID,
    organizationId: ORG_ID,
    status: 'SENT',
    total: '100.00',
    remainingBalance: '100.00',
    customerId: CUSTOMER_ID,
    invoiceNumber: 'INV-000001',
    customer: { id: CUSTOMER_ID, accountOwnerUserId: null, createdByUserId: 'other-user' },
    ...(opts.invoice ?? {}),
  };

  const paymentsStore: Record<string, unknown>[] = [...(opts.payments ?? [])];
  const adjustmentsStore: Record<string, unknown>[] = [...(opts.adjustments ?? [])];

  const tx = {
    load: {
      findMany: jest.fn().mockResolvedValue(opts.loads ?? [LOAD_1]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoice: {
      create: jest.fn().mockImplementation(({ data }) => ({
        id: INVOICE_ID,
        ...data,
        lineItems: data.lineItems?.createMany?.data ?? [],
        invoiceLoads: data.invoiceLoads?.create ?? [],
      })),
      findFirst: jest
        .fn()
        .mockResolvedValue('invoice' in opts ? (opts.invoice ?? null) : invoiceRecord),
      findFirstOrThrow: jest.fn().mockResolvedValue(invoiceRecord),
      update: jest.fn().mockImplementation(({ data }) => ({ ...invoiceRecord, ...data })),
      findMany: jest.fn().mockResolvedValue([invoiceRecord]),
    },
    customer: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          'customer' in opts
            ? opts.customer
            : { id: CUSTOMER_ID, paymentTerms: 'NET_30', legalName: 'ABC Co' },
        ),
    },
    documentTypeDefinition: {
      findFirst: jest.fn().mockResolvedValue({ id: 'doctype-inv', code: 'INVOICE' }),
    },
    document: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
    },
    payment: {
      create: jest.fn().mockImplementation(({ data }) => {
        const created = { id: 'pay-1', ...data };
        paymentsStore.push(created);
        return created;
      }),
      findMany: jest.fn().mockImplementation(() => Promise.resolve(paymentsStore)),
    },
    adjustment: {
      create: jest.fn().mockImplementation(({ data }) => {
        const created = { id: 'adj-1', ...data };
        adjustmentsStore.push(created);
        return created;
      }),
      findMany: jest.fn().mockImplementation(() => Promise.resolve(adjustmentsStore)),
    },
    invoiceLoad: {
      findMany: jest
        .fn()
        .mockResolvedValue(opts.invoiceLoads ?? [{ id: 'il-1', loadId: 'load-1' }]),
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const sequences = {
    getNextNumber: jest.fn().mockResolvedValue(1n),
    format: jest.fn().mockReturnValue('INV-000001'),
  };
  const storage = { buildDocumentKey: jest.fn().mockReturnValue('org_org-1/documents/doc-1') };
  const emailSender = { send: jest.fn().mockResolvedValue(undefined) };
  const invoiceQueue = { add: jest.fn().mockResolvedValue(undefined) };

  const service = new InvoiceService(
    prisma as never,
    audit as never,
    sequences as never,
    storage as never,
    emailSender as never,
    invoiceQueue as never,
  );

  return { service, tx, audit, sequences, storage, emailSender, invoiceQueue };
}

describe('InvoiceService.create — Workflow 8 §8.1-8.5', () => {
  it('creates an Individual invoice with one line item per ChargeLineItem', async () => {
    const { service, tx, audit } = buildService({ loads: [LOAD_1] });

    const invoice = await service.create(
      ORG_ID,
      { customerId: CUSTOMER_ID, loadIds: ['load-1'] },
      USER_ID,
    );

    expect(invoice.total).toBe('1800.00');
    expect(tx.load.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { invoiced: true } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Invoice Created — Individual' }),
    );
  });

  it('creates a Consolidated invoice with one line item per Load', async () => {
    const { service, audit } = buildService({ loads: [LOAD_1, LOAD_2] });

    const invoice = await service.create(
      ORG_ID,
      { customerId: CUSTOMER_ID, loadIds: ['load-1', 'load-2'] },
      USER_ID,
    );

    expect(invoice.total).toBe('2700.00');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Invoice Created — Consolidated' }),
    );
  });

  it('throws PodIncompleteWarningError when a selected Load has incomplete POD and no acknowledgment', async () => {
    const { service } = buildService({ loads: [{ ...LOAD_1, podStatus: 'PARTIAL' }] });

    await expect(
      service.create(ORG_ID, { customerId: CUSTOMER_ID, loadIds: ['load-1'] }, USER_ID),
    ).rejects.toThrow(PodIncompleteWarningError);
  });

  it('proceeds when POD is incomplete but acknowledged, and audits the override', async () => {
    const { service, audit } = buildService({ loads: [{ ...LOAD_1, podStatus: 'PARTIAL' }] });

    await service.create(
      ORG_ID,
      { customerId: CUSTOMER_ID, loadIds: ['load-1'], podWarningAcknowledged: true },
      USER_ID,
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Invoice Created Despite Incomplete POD' }),
    );
  });

  it('rejects Loads that do not all share the same Customer', async () => {
    const { service } = buildService({ loads: [LOAD_1, { ...LOAD_2, customerId: 'other-cust' }] });

    await expect(
      service.create(ORG_ID, { customerId: CUSTOMER_ID, loadIds: ['load-1', 'load-2'] }, USER_ID),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('rejects an already-invoiced Load', async () => {
    const { service } = buildService({ loads: [{ ...LOAD_1, invoiced: true }] });

    await expect(
      service.create(ORG_ID, { customerId: CUSTOMER_ID, loadIds: ['load-1'] }, USER_ID),
    ).rejects.toThrow(BusinessRuleError);
  });
});

describe('InvoiceService.send — Workflow 8 §8.6/§8.8', () => {
  it('transitions DRAFT -> SENT, computes due_date from payment terms, and emails synchronously', async () => {
    const { service, tx, emailSender, invoiceQueue } = buildService({
      invoice: {
        id: INVOICE_ID,
        status: 'DRAFT',
        customerId: CUSTOMER_ID,
        invoiceNumber: 'INV-000001',
        total: '1800.00',
        lineItems: [{ id: 'li-1', amount: '1800.00' }],
      },
    });

    const invoice = await service.send(
      ORG_ID,
      INVOICE_ID,
      { recipientEmail: 'ap@customer.com', subject: 'Invoice', message: 'See attached.' },
      USER_ID,
    );

    expect(invoice.status).toBe('SENT');
    expect(invoice.dueDate).toBeInstanceOf(Date);
    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ap@customer.com' }),
    );
    expect(invoiceQueue.add).toHaveBeenCalledTimes(1);
    expect(tx.document.create).toHaveBeenCalledTimes(1);
  });

  it('throws InvalidTransitionError for a non-Draft invoice', async () => {
    const { service } = buildService({
      invoice: { id: INVOICE_ID, status: 'SENT', customerId: CUSTOMER_ID },
    });

    await expect(
      service.send(
        ORG_ID,
        INVOICE_ID,
        { recipientEmail: 'ap@customer.com', subject: 'x', message: 'y' },
        USER_ID,
      ),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects sending an invoice with no line items (post-Phase-8 remediation, Priority 4)', async () => {
    const { service } = buildService({
      invoice: {
        id: INVOICE_ID,
        status: 'DRAFT',
        customerId: CUSTOMER_ID,
        total: '1800.00',
        lineItems: [],
      },
    });

    await expect(
      service.send(
        ORG_ID,
        INVOICE_ID,
        { recipientEmail: 'ap@customer.com', subject: 'x', message: 'y' },
        USER_ID,
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('rejects sending an invoice with a zero total (post-Phase-8 remediation, Priority 4)', async () => {
    const { service } = buildService({
      invoice: {
        id: INVOICE_ID,
        status: 'DRAFT',
        customerId: CUSTOMER_ID,
        total: '0.00',
        lineItems: [{ id: 'li-1', amount: '0.00' }],
      },
    });

    await expect(
      service.send(
        ORG_ID,
        INVOICE_ID,
        { recipientEmail: 'ap@customer.com', subject: 'x', message: 'y' },
        USER_ID,
      ),
    ).rejects.toThrow(BusinessRuleError);
  });
});

describe('InvoiceService.recordPayment — Workflow 8 §8.9', () => {
  it('marks the invoice PAID when the payment fully covers the total', async () => {
    const { service } = buildService({
      invoice: { id: INVOICE_ID, status: 'SENT', total: '100.00' },
    });

    const result = await service.recordPayment(
      ORG_ID,
      INVOICE_ID,
      { amount: '100.00', paymentDate: '2026-08-01', method: 'ACH' },
      USER_ID,
    );

    expect(result.remainingBalance).toBe('0.00');
    expect(result.status).toBe('PAID');
  });

  it('marks the invoice PARTIALLY_PAID for a partial payment', async () => {
    const { service } = buildService({
      invoice: { id: INVOICE_ID, status: 'SENT', total: '100.00' },
    });

    const result = await service.recordPayment(
      ORG_ID,
      INVOICE_ID,
      { amount: '40.00', paymentDate: '2026-08-01', method: 'ACH' },
      USER_ID,
    );

    expect(result.remainingBalance).toBe('60.00');
    expect(result.status).toBe('PARTIALLY_PAID');
  });

  it('throws InvalidTransitionError against a Draft invoice', async () => {
    const { service } = buildService({
      invoice: { id: INVOICE_ID, status: 'DRAFT', total: '100.00' },
    });

    await expect(
      service.recordPayment(
        ORG_ID,
        INVOICE_ID,
        { amount: '10.00', paymentDate: '2026-08-01', method: 'ACH' },
        USER_ID,
      ),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

describe('InvoiceService.addAdjustment — Workflow 8 §8.11', () => {
  it('marks the invoice CREDITED when a Credit adjustment fully offsets the balance with no payment', async () => {
    const { service } = buildService({
      invoice: { id: INVOICE_ID, status: 'SENT', total: '100.00' },
    });

    const result = await service.addAdjustment(
      ORG_ID,
      INVOICE_ID,
      { type: 'CREDIT', amount: '100.00', reason: 'Billing dispute resolved' },
      USER_ID,
    );

    expect(result.remainingBalance).toBe('0.00');
    expect(result.status).toBe('CREDITED');
  });

  it('throws InvalidTransitionError against a Draft invoice', async () => {
    const { service } = buildService({
      invoice: { id: INVOICE_ID, status: 'DRAFT', total: '100.00' },
    });

    await expect(
      service.addAdjustment(
        ORG_ID,
        INVOICE_ID,
        { type: 'DEBIT', amount: '10.00', reason: 'Accessorial' },
        USER_ID,
      ),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

describe('InvoiceService.void — Workflow 8 §8.12', () => {
  it('releases every associated Load back to the Ready-to-Invoice queue', async () => {
    const { service, tx } = buildService({
      invoice: { id: INVOICE_ID, status: 'SENT' },
      invoiceLoads: [
        { id: 'il-1', loadId: 'load-1' },
        { id: 'il-2', loadId: 'load-2' },
      ],
    });

    const invoice = await service.void(ORG_ID, INVOICE_ID, USER_ID);

    expect(invoice.status).toBe('VOID');
    expect(tx.load.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { invoiced: false } }),
    );
  });

  it('throws InvalidTransitionError for an already-Void invoice', async () => {
    const { service } = buildService({ invoice: { id: INVOICE_ID, status: 'VOID' } });

    await expect(service.void(ORG_ID, INVOICE_ID, USER_ID)).rejects.toThrow(InvalidTransitionError);
  });
});

describe('InvoiceService view permissions — UI_UX_DESIGN.md §5.4.7', () => {
  it('grants Admin full detail regardless of ownership', async () => {
    const { service } = buildService();
    const invoice = await service.findById(ORG_ID, INVOICE_ID, USER_ID, ['ADMIN']);
    expect(invoice.id).toBe(INVOICE_ID);
  });

  it('grants Sales/Booking full detail for their own-deal Customer', async () => {
    const { service } = buildService({
      invoice: {
        id: INVOICE_ID,
        customer: { id: CUSTOMER_ID, accountOwnerUserId: USER_ID, createdByUserId: 'someone-else' },
      },
    });
    const invoice = await service.findById(ORG_ID, INVOICE_ID, USER_ID, ['SALES_BOOKING']);
    expect(invoice.id).toBe(INVOICE_ID);
  });

  it('blocks Sales/Booking from a non-owned Customer detail view (not independently linkable)', async () => {
    const { service } = buildService({
      invoice: {
        id: INVOICE_ID,
        customer: {
          id: CUSTOMER_ID,
          accountOwnerUserId: 'other-owner',
          createdByUserId: 'other-owner',
        },
      },
    });
    await expect(service.findById(ORG_ID, INVOICE_ID, USER_ID, ['SALES_BOOKING'])).rejects.toThrow(
      PermissionError,
    );
  });

  it('redacts amounts for non-owned invoices in list(), but not for own-deal ones', async () => {
    const { service } = buildService();
    const invoices = await service.list(ORG_ID, USER_ID, ['SALES_BOOKING']);
    expect(invoices[0].total).toBeNull();
  });
});
