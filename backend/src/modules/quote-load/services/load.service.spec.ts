import { Prisma } from '@prisma/client';
import { LoadService } from './load.service';
import { BusinessRuleError, NotFoundError } from '../../../common/errors/app-error';

const ORG_ID = 'org-1';
const CUSTOMER_ID = 'customer-1';
const USER_ID = 'user-1';

const BASE_STOPS = [
  {
    sequence: 1,
    stopType: 'PICKUP',
    addressLine1: '1 Dock Rd',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
  },
  {
    sequence: 2,
    stopType: 'DELIVERY',
    addressLine1: '2 Dock Rd',
    city: 'Chicago',
    state: 'IL',
    zip: '60601',
  },
];

function buildService(opts: {
  customer?: { id: string; status: string } | null;
  rateMatch?: { rateAgreementId: string | null; rateSource: string } | null;
}) {
  const customerLookupResult =
    'customer' in opts ? opts.customer : { id: CUSTOMER_ID, status: 'ACTIVE' };
  const tx = {
    customer: {
      findFirst: jest.fn().mockResolvedValue(customerLookupResult),
    },
    load: {
      findFirst: jest.fn(),
      create: jest.fn().mockImplementation(({ data }) => ({
        ...data,
        id: 'load-1',
        customerRate: new Prisma.Decimal(data.customerRate),
        stops: data.stops.create,
      })),
      update: jest
        .fn()
        .mockImplementation(({ data }) => ({ id: 'load-1', status: 'BOOKED', ...data })),
    },
    document: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const sequences = {
    getNextNumber: jest.fn().mockResolvedValue(456n),
    format: jest.fn().mockReturnValue('LOAD-000456'),
  };
  const rateAgreementMatching = {
    resolveRate: jest
      .fn()
      .mockResolvedValue(opts.rateMatch ?? { rateAgreementId: null, rateSource: 'MANUAL' }),
  };

  const service = new LoadService(
    prisma as never,
    audit as never,
    sequences as never,
    rateAgreementMatching as never,
  );

  return { service, tx, audit, sequences, rateAgreementMatching };
}

describe('LoadService.createDirect — Workflow 4 §4.8', () => {
  it('creates a Load at status BOOKED with bookingSource=DIRECT, quoteId=NULL, dispatcherId=NULL', async () => {
    const { service, sequences, audit } = buildService({});

    const load = await service.createDirect(
      ORG_ID,
      {
        customerId: CUSTOMER_ID,
        stops: BASE_STOPS as never,
        equipmentType: 'DRY_VAN',
        customerRate: '1800.00',
      },
      USER_ID,
    );

    expect(load.status).toBe('BOOKED');
    expect(load.loadNumber).toBe('LOAD-000456');
    expect(load.bookingSource).toBe('DIRECT');
    expect(load.quoteId).toBeNull();
    expect(load.assignedDispatcherId).toBeUndefined();
    expect(sequences.getNextNumber).toHaveBeenCalledWith(expect.anything(), ORG_ID, 'LOAD');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Load Booked Directly (No Quote)' }),
    );
  });

  it('rejects booking when Customer is Prospect', async () => {
    const { service } = buildService({ customer: { id: CUSTOMER_ID, status: 'PROSPECT' } });

    await expect(
      service.createDirect(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: BASE_STOPS as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        },
        USER_ID,
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('rejects booking when Customer is Blocked, with no override possible', async () => {
    const { service } = buildService({ customer: { id: CUSTOMER_ID, status: 'BLOCKED' } });

    await expect(
      service.createDirect(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: BASE_STOPS as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
          confirmInactiveCustomerOverride: true,
        },
        USER_ID,
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('rejects booking when Customer is Inactive without an explicit override confirmation', async () => {
    const { service } = buildService({ customer: { id: CUSTOMER_ID, status: 'INACTIVE' } });

    await expect(
      service.createDirect(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: BASE_STOPS as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        },
        USER_ID,
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('allows booking when Customer is Inactive with an explicit override, and audits it', async () => {
    const { service, audit } = buildService({ customer: { id: CUSTOMER_ID, status: 'INACTIVE' } });

    const load = await service.createDirect(
      ORG_ID,
      {
        customerId: CUSTOMER_ID,
        stops: BASE_STOPS as never,
        equipmentType: 'DRY_VAN',
        customerRate: '100.00',
        confirmInactiveCustomerOverride: true,
      },
      USER_ID,
    );

    expect(load.status).toBe('BOOKED');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Inactive Customer Booking Override' }),
    );
  });

  it('rejects creation when Customer does not exist in this org', async () => {
    const { service } = buildService({ customer: null });

    await expect(
      service.createDirect(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: BASE_STOPS as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        },
        USER_ID,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects creation with no pickup or no delivery stop', async () => {
    const { service } = buildService({});

    await expect(
      service.createDirect(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: [BASE_STOPS[0]] as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        },
        USER_ID,
      ),
    ).rejects.toThrow(BusinessRuleError);
  });
});

describe('LoadService.updateReferenceNumbers — Workflow 4 §4.10', () => {
  it('updates reference numbers and audits the field-level diff', async () => {
    const { service, tx, audit } = buildService({});
    tx.load.findFirst.mockResolvedValue({ id: 'load-1', customerPoNumber: null, bolNumber: null });

    const updated = await service.updateReferenceNumbers(
      ORG_ID,
      'load-1',
      { customerPoNumber: 'PO-123' },
      USER_ID,
    );

    expect(updated.customerPoNumber).toBe('PO-123');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Reference Number Added/Updated' }),
    );
  });

  it('does not audit when nothing actually changed', async () => {
    const { service, tx, audit } = buildService({});
    tx.load.findFirst.mockResolvedValue({ id: 'load-1', customerPoNumber: 'PO-123' });

    await service.updateReferenceNumbers(ORG_ID, 'load-1', { customerPoNumber: 'PO-123' }, USER_ID);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('throws NotFoundError for a nonexistent Load', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue(null);

    await expect(
      service.updateReferenceNumbers(
        ORG_ID,
        'nonexistent',
        { customerPoNumber: 'PO-123' },
        USER_ID,
      ),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('LoadService — role-based financial field shaping (§7)', () => {
  it('strips $ fields for a Dispatcher-only viewer', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({
      id: 'load-1',
      createdByUserId: 'someone-else',
      customerRate: new Prisma.Decimal('100.00'),
      rateSource: 'MANUAL',
      rateAgreementId: null,
      stops: [],
    });

    const load = await service.findById(ORG_ID, 'load-1', USER_ID, ['DISPATCHER']);
    expect(load.customerRate).toBeNull();
  });
});
