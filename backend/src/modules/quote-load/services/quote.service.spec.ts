import { Prisma } from '@prisma/client';
import { QuoteService } from './quote.service';
import {
  BusinessRuleError,
  InvalidTransitionError,
  NotFoundError,
} from '../../../common/errors/app-error';

const ORG_ID = 'org-1';
const CUSTOMER_ID = 'customer-1';
const USER_ID = 'user-1';

const BASE_STOPS = [
  {
    sequence: 1,
    stopType: 'PICKUP',
    addressCity: 'Dallas',
    addressState: 'TX',
    addressZip: '75201',
  },
  {
    sequence: 2,
    stopType: 'DELIVERY',
    addressCity: 'Chicago',
    addressState: 'IL',
    addressZip: '60601',
  },
];

function buildService(opts: {
  customer?: { status: string } | null;
  rateMatch?: { rateAgreementId: string | null; rateSource: string } | null;
}) {
  const customerLookupResult =
    'customer' in opts ? opts.customer : { id: CUSTOMER_ID, status: 'ACTIVE' };
  const tx = {
    customer: {
      findFirst: jest.fn().mockResolvedValue(customerLookupResult),
    },
    quote: {
      findFirst: jest.fn(),
      create: jest.fn().mockImplementation(({ data }) => ({
        ...data,
        id: 'quote-1',
        customerRate: new Prisma.Decimal(data.customerRate),
        stops: data.stops.create,
      })),
      update: jest
        .fn()
        .mockImplementation(({ data }) => ({ id: 'quote-1', status: 'OPEN', ...data })),
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const sequences = {
    getNextNumber: jest.fn().mockResolvedValue(123n),
    format: jest.fn().mockReturnValue('QUOTE-000123'),
  };
  const rateAgreementMatching = {
    resolveRate: jest
      .fn()
      .mockResolvedValue(opts.rateMatch ?? { rateAgreementId: null, rateSource: 'MANUAL' }),
  };
  const loadService = {
    assertCustomerAllowsBooking: jest.fn().mockResolvedValue(undefined),
    createFromBooking: jest.fn().mockImplementation((_tx, _orgId, params) => ({
      id: 'load-1',
      status: 'BOOKED',
      bookingSource: params.bookingSource,
      quoteId: params.quoteId,
      customerRate: new Prisma.Decimal(params.customerRate),
    })),
  };

  const service = new QuoteService(
    prisma as never,
    audit as never,
    sequences as never,
    rateAgreementMatching as never,
    loadService as never,
  );

  return { service, tx, audit, sequences, rateAgreementMatching, loadService };
}

describe('QuoteService.create — Workflow 4 §4.2', () => {
  it('creates a Quote at status OPEN with a generated number, when Customer is Active', async () => {
    const { service, sequences, audit } = buildService({});

    const quote = await service.create(
      ORG_ID,
      {
        customerId: CUSTOMER_ID,
        stops: BASE_STOPS as never,
        equipmentType: 'DRY_VAN',
        customerRate: '2450.00',
      },
      USER_ID,
    );

    expect(quote.status).toBe('OPEN');
    expect(quote.quoteNumber).toBe('QUOTE-000123');
    expect(sequences.getNextNumber).toHaveBeenCalledWith(expect.anything(), ORG_ID, 'QUOTE');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Quote Created' }),
    );
  });

  it('allows creation when Customer is Prospect or Inactive (§4.3 — only Blocked hard-stops the Quote path)', async () => {
    const { service: prospectService } = buildService({ customer: { status: 'PROSPECT' } });
    await expect(
      prospectService.create(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: BASE_STOPS as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        },
        USER_ID,
      ),
    ).resolves.toBeDefined();

    const { service: inactiveService } = buildService({ customer: { status: 'INACTIVE' } });
    await expect(
      inactiveService.create(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: BASE_STOPS as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        },
        USER_ID,
      ),
    ).resolves.toBeDefined();
  });

  it('rejects creation when Customer is Blocked', async () => {
    const { service } = buildService({ customer: { status: 'BLOCKED' } });

    await expect(
      service.create(
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

  it('rejects creation when Customer does not exist in this org', async () => {
    const { service } = buildService({ customer: null });

    await expect(
      service.create(
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

  it('rejects creation with no pickup stop', async () => {
    const { service } = buildService({});
    const stops = [BASE_STOPS[1]];

    await expect(
      service.create(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: stops as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        },
        USER_ID,
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('rejects creation with no delivery stop', async () => {
    const { service } = buildService({});
    const stops = [BASE_STOPS[0]];

    await expect(
      service.create(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: stops as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        },
        USER_ID,
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('sets rateSource=RATE_AGREEMENT and retains rateAgreementId when a match is accepted as-is', async () => {
    const { service } = buildService({
      rateMatch: { rateAgreementId: 'agreement-1', rateSource: 'RATE_AGREEMENT' },
    });

    const quote = await service.create(
      ORG_ID,
      {
        customerId: CUSTOMER_ID,
        stops: BASE_STOPS as never,
        equipmentType: 'DRY_VAN',
        customerRate: '2450.00',
      },
      USER_ID,
    );

    expect(quote.rateSource).toBe('RATE_AGREEMENT');
    expect(quote.rateAgreementId).toBe('agreement-1');
  });

  it('sets rateSource=MANUAL_OVERRIDE and still retains rateAgreementId when the suggested rate is overridden', async () => {
    const { service } = buildService({
      rateMatch: { rateAgreementId: 'agreement-1', rateSource: 'MANUAL_OVERRIDE' },
    });

    const quote = await service.create(
      ORG_ID,
      {
        customerId: CUSTOMER_ID,
        stops: BASE_STOPS as never,
        equipmentType: 'DRY_VAN',
        customerRate: '2999.00',
      },
      USER_ID,
    );

    expect(quote.rateSource).toBe('MANUAL_OVERRIDE');
    expect(quote.rateAgreementId).toBe('agreement-1');
  });
});

describe('QuoteService.convert — Workflow 4 §4.7', () => {
  const OPEN_QUOTE = {
    id: 'quote-1',
    organizationId: ORG_ID,
    customerId: CUSTOMER_ID,
    status: 'OPEN',
    equipmentType: 'DRY_VAN',
    customerRate: new Prisma.Decimal('2450.00'),
    rateSource: 'MANUAL',
    rateAgreementId: null,
    stops: [
      {
        sequence: 1,
        stopType: 'PICKUP',
        addressCity: 'Dallas',
        addressState: 'TX',
        addressZip: '75201',
        appointmentNotes: null,
      },
      {
        sequence: 2,
        stopType: 'DELIVERY',
        addressCity: 'Chicago',
        addressState: 'IL',
        addressZip: '60601',
        appointmentNotes: null,
      },
    ],
  };

  it('creates a Load (bookingSource=QUOTE, quoteId set) and flips the Quote to WON with resultingLoadId set', async () => {
    const { service, tx, loadService, audit } = buildService({});
    tx.quote.findFirst.mockResolvedValue(OPEN_QUOTE);

    const load = await service.convert(
      ORG_ID,
      'quote-1',
      { confirmedCustomerRate: '2450.00' },
      USER_ID,
    );

    expect(load.bookingSource).toBe('QUOTE');
    expect(load.quoteId).toBe('quote-1');
    expect(loadService.createFromBooking).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      expect.objectContaining({ auditAction: 'Load Booked From Quote' }),
    );
    expect(tx.quote.update).toHaveBeenCalledWith({
      where: { id: 'quote-1' },
      data: { status: 'WON', resultingLoadId: 'load-1' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Quote Won — Converted to Load' }),
    );
  });

  it('does not record Rate Changed During Conversion when the confirmed rate matches the original', async () => {
    const { service, tx, audit } = buildService({});
    tx.quote.findFirst.mockResolvedValue(OPEN_QUOTE);

    await service.convert(ORG_ID, 'quote-1', { confirmedCustomerRate: '2450.00' }, USER_ID);

    expect(audit.record).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Rate Changed During Conversion' }),
    );
  });

  it("records Rate Changed During Conversion when the confirmed rate differs, and leaves the Quote's own rate unchanged", async () => {
    const { service, tx, audit } = buildService({});
    tx.quote.findFirst.mockResolvedValue(OPEN_QUOTE);

    await service.convert(ORG_ID, 'quote-1', { confirmedCustomerRate: '2600.00' }, USER_ID);

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'Rate Changed During Conversion',
        previousValue: { customerRate: '2450' },
        newValue: { customerRate: '2600.00' },
      }),
    );
    // The Quote update call only ever sets status/resultingLoadId — never customerRate.
    expect(tx.quote.update).toHaveBeenCalledWith({
      where: { id: 'quote-1' },
      data: { status: 'WON', resultingLoadId: 'load-1' },
    });
  });

  it('rejects converting an already-WON Quote', async () => {
    const { service, tx } = buildService({});
    tx.quote.findFirst.mockResolvedValue({ ...OPEN_QUOTE, status: 'WON' });

    await expect(
      service.convert(ORG_ID, 'quote-1', { confirmedCustomerRate: '2450.00' }, USER_ID),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects converting an already-LOST Quote', async () => {
    const { service, tx } = buildService({});
    tx.quote.findFirst.mockResolvedValue({ ...OPEN_QUOTE, status: 'LOST' });

    await expect(
      service.convert(ORG_ID, 'quote-1', { confirmedCustomerRate: '2450.00' }, USER_ID),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('re-runs Customer Status Validation against the Booking column (blocks a Blocked customer)', async () => {
    const { service, tx, loadService } = buildService({ customer: { status: 'BLOCKED' } });
    tx.quote.findFirst.mockResolvedValue(OPEN_QUOTE);
    loadService.assertCustomerAllowsBooking.mockRejectedValue(new BusinessRuleError('blocked'));

    await expect(
      service.convert(ORG_ID, 'quote-1', { confirmedCustomerRate: '2450.00' }, USER_ID),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws NotFoundError for a nonexistent Quote', async () => {
    const { service, tx } = buildService({});
    tx.quote.findFirst.mockResolvedValue(null);

    await expect(
      service.convert(ORG_ID, 'nonexistent', { confirmedCustomerRate: '100.00' }, USER_ID),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('QuoteService.markLost — Workflow 4 §4.6', () => {
  it('marks an OPEN Quote Lost with the given reason', async () => {
    const { service, tx, audit } = buildService({});
    tx.quote.findFirst.mockResolvedValue({ id: 'quote-1', status: 'OPEN' });

    const updated = await service.markLost(
      ORG_ID,
      'quote-1',
      { reason: 'Customer went with another carrier' },
      USER_ID,
    );

    expect(updated.status).toBe('LOST');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Quote Marked Lost' }),
    );
  });

  it('rejects marking an already-WON Quote as Lost', async () => {
    const { service, tx } = buildService({});
    tx.quote.findFirst.mockResolvedValue({ id: 'quote-1', status: 'WON' });

    await expect(service.markLost(ORG_ID, 'quote-1', { reason: 'x' }, USER_ID)).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it('rejects marking an already-LOST Quote as Lost again — permanently terminal', async () => {
    const { service, tx } = buildService({});
    tx.quote.findFirst.mockResolvedValue({ id: 'quote-1', status: 'LOST' });

    await expect(service.markLost(ORG_ID, 'quote-1', { reason: 'x' }, USER_ID)).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it('throws NotFoundError for a nonexistent Quote', async () => {
    const { service, tx } = buildService({});
    tx.quote.findFirst.mockResolvedValue(null);

    await expect(service.markLost(ORG_ID, 'nonexistent', { reason: 'x' }, USER_ID)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('QuoteService — role-based financial field shaping (§7)', () => {
  it('strips $ fields for a Dispatcher-only viewer', async () => {
    const { service, tx } = buildService({});
    tx.quote.findFirst.mockResolvedValue({
      id: 'quote-1',
      createdByUserId: 'someone-else',
      customerRate: new Prisma.Decimal('100.00'),
      rateSource: 'MANUAL',
      rateAgreementId: null,
      stops: [],
    });

    const quote = await service.findById(ORG_ID, 'quote-1', USER_ID, ['DISPATCHER']);
    expect(quote.customerRate).toBeNull();
  });

  it('shows $ fields to Sales/Booking only on their own Quote', async () => {
    const { service, tx } = buildService({});
    tx.quote.findFirst.mockResolvedValue({
      id: 'quote-1',
      createdByUserId: USER_ID,
      customerRate: new Prisma.Decimal('100.00'),
      rateSource: 'MANUAL',
      rateAgreementId: null,
      stops: [],
    });

    const ownQuote = await service.findById(ORG_ID, 'quote-1', USER_ID, ['SALES_BOOKING']);
    expect(ownQuote.customerRate).not.toBeNull();

    tx.quote.findFirst.mockResolvedValue({
      id: 'quote-2',
      createdByUserId: 'someone-else',
      customerRate: new Prisma.Decimal('100.00'),
      rateSource: 'MANUAL',
      rateAgreementId: null,
      stops: [],
    });
    const othersQuote = await service.findById(ORG_ID, 'quote-2', USER_ID, ['SALES_BOOKING']);
    expect(othersQuote.customerRate).toBeNull();
  });

  it('shows $ fields to Admin regardless of ownership', async () => {
    const { service, tx } = buildService({});
    tx.quote.findFirst.mockResolvedValue({
      id: 'quote-1',
      createdByUserId: 'someone-else',
      customerRate: new Prisma.Decimal('100.00'),
      rateSource: 'MANUAL',
      rateAgreementId: null,
      stops: [],
    });

    const quote = await service.findById(ORG_ID, 'quote-1', USER_ID, ['ADMIN']);
    expect(quote.customerRate).not.toBeNull();
  });
});
