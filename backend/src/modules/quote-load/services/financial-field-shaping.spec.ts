import { shapeFinancialFields, shapeFinancialFieldsList } from './financial-field-shaping';

const OWNER_ID = 'user-owner';
const OTHER_USER_ID = 'user-other';

const LOAD_RECORD = {
  id: 'load-1',
  createdByUserId: OWNER_ID,
  customerRate: '1800.00',
  rateSource: 'MANUAL',
  rateAgreementId: null,
  carrierRate: '1500.00',
};

const QUOTE_RECORD = {
  id: 'quote-1',
  createdByUserId: OWNER_ID,
  customerRate: '1200.00',
  rateSource: 'MANUAL',
  rateAgreementId: null,
};

const READY_TO_INVOICE_RECORD = {
  ...LOAD_RECORD,
  customerChargesTotal: '1800.00',
};

const LOAD_WITH_SOURCING_ATTEMPTS = {
  ...LOAD_RECORD,
  sourcingAttempts: [
    { id: 'attempt-1', outcome: 'DECLINED', carrierRate: null },
    { id: 'attempt-2', outcome: 'ASSIGNED', carrierRate: '1500.00' },
  ],
};

const LOAD_WITH_CHARGE_LINE_ITEMS = {
  ...LOAD_RECORD,
  chargeLineItems: [
    { id: 'charge-1', side: 'CUSTOMER' as const, amount: '1800.00' },
    { id: 'charge-2', side: 'CARRIER' as const, amount: '1500.00' },
  ],
};

describe('shapeFinancialFields — post-Phase-8 remediation (Priority 1)', () => {
  it('leaves carrierRate and customerChargesTotal untouched for full-visibility roles', () => {
    const result = shapeFinancialFields(READY_TO_INVOICE_RECORD, ['ADMIN'], OTHER_USER_ID);
    expect(result.carrierRate).toBe('1500.00');
    expect(result.customerChargesTotal).toBe('1800.00');
  });

  it('redacts carrierRate and customerChargesTotal for Dispatcher', () => {
    const result = shapeFinancialFields(READY_TO_INVOICE_RECORD, ['DISPATCHER'], OTHER_USER_ID);
    expect(result.carrierRate).toBeNull();
    expect(result.customerChargesTotal).toBeNull();
    expect(result.customerRate).toBeNull();
  });

  it('redacts carrierRate for Sales/Booking on a record they did not create', () => {
    const result = shapeFinancialFields(LOAD_RECORD, ['SALES_BOOKING'], OTHER_USER_ID);
    expect(result.carrierRate).toBeNull();
  });

  it('leaves customerRate visible but still redacts carrierRate for Sales/Booking on their own record (Phase 4 correction)', () => {
    // Margin is never shown to Sales/Booking regardless of ownership
    // (§5.4.1 Resolution 1) — an unredacted carrierRate would let the
    // exact same figure be derived client-side from customerRate minus
    // carrierRate, so carrier-side visibility never follows ownership,
    // only customer-side visibility does.
    const result = shapeFinancialFields(LOAD_RECORD, ['SALES_BOOKING'], OWNER_ID);
    expect(result.customerRate).toBe('1800.00');
    expect(result.carrierRate).toBeNull();
  });

  it('does not add a carrierRate/customerChargesTotal key to a record that never had one (Quote)', () => {
    const result = shapeFinancialFields(QUOTE_RECORD, ['DISPATCHER'], OTHER_USER_ID);
    expect('carrierRate' in result).toBe(false);
    expect('customerChargesTotal' in result).toBe(false);
    expect(result.customerRate).toBeNull();
  });

  it('redacts carrierRate on every nested sourcingAttempts entry for Dispatcher', () => {
    const result = shapeFinancialFields(LOAD_WITH_SOURCING_ATTEMPTS, ['DISPATCHER'], OTHER_USER_ID);
    expect(result.sourcingAttempts.map((a) => a.carrierRate)).toEqual([null, null]);
    // Non-financial fields on each attempt survive the redaction untouched.
    expect(result.sourcingAttempts.map((a) => a.outcome)).toEqual(['DECLINED', 'ASSIGNED']);
  });

  it('redacts nested sourcingAttempts carrierRate for Sales/Booking on a record they did not create', () => {
    const result = shapeFinancialFields(
      LOAD_WITH_SOURCING_ATTEMPTS,
      ['SALES_BOOKING'],
      OTHER_USER_ID,
    );
    expect(result.sourcingAttempts.every((a) => a.carrierRate === null)).toBe(true);
  });

  it('leaves nested sourcingAttempts carrierRate visible for full-visibility roles', () => {
    const result = shapeFinancialFields(LOAD_WITH_SOURCING_ATTEMPTS, ['ADMIN'], OTHER_USER_ID);
    expect(result.sourcingAttempts[1].carrierRate).toBe('1500.00');
  });

  it('does not add a sourcingAttempts key to a record that never had one (Quote)', () => {
    const result = shapeFinancialFields(QUOTE_RECORD, ['DISPATCHER'], OTHER_USER_ID);
    expect('sourcingAttempts' in result).toBe(false);
  });

  it('still redacts nested sourcingAttempts carrierRate for Sales/Booking on their own record', () => {
    const result = shapeFinancialFields(LOAD_WITH_SOURCING_ATTEMPTS, ['SALES_BOOKING'], OWNER_ID);
    expect(result.sourcingAttempts.every((a) => a.carrierRate === null)).toBe(true);
  });

  it('redacts only the CARRIER-side chargeLineItems amount for Dispatcher, both sides for a non-owning Sales/Booking, and shows CUSTOMER-side only for an owning Sales/Booking', () => {
    const dispatcherResult = shapeFinancialFields(
      LOAD_WITH_CHARGE_LINE_ITEMS,
      ['DISPATCHER'],
      OTHER_USER_ID,
    );
    expect(dispatcherResult.chargeLineItems!.map((c) => c.amount)).toEqual([null, null]);

    const nonOwningSalesResult = shapeFinancialFields(
      LOAD_WITH_CHARGE_LINE_ITEMS,
      ['SALES_BOOKING'],
      OTHER_USER_ID,
    );
    expect(nonOwningSalesResult.chargeLineItems!.map((c) => c.amount)).toEqual([null, null]);

    const owningSalesResult = shapeFinancialFields(
      LOAD_WITH_CHARGE_LINE_ITEMS,
      ['SALES_BOOKING'],
      OWNER_ID,
    );
    expect(owningSalesResult.chargeLineItems!.map((c) => c.amount)).toEqual(['1800.00', null]);
    expect(owningSalesResult.chargeLineItems!.map((c) => c.side)).toEqual(['CUSTOMER', 'CARRIER']);
  });

  it('leaves both sides of chargeLineItems visible for full-visibility roles', () => {
    const result = shapeFinancialFields(LOAD_WITH_CHARGE_LINE_ITEMS, ['ACCOUNTING'], OTHER_USER_ID);
    expect(result.chargeLineItems!.map((c) => c.amount)).toEqual(['1800.00', '1500.00']);
  });

  it('does not add a chargeLineItems key to a record that never had one (Quote)', () => {
    const result = shapeFinancialFields(QUOTE_RECORD, ['DISPATCHER'], OTHER_USER_ID);
    expect('chargeLineItems' in result).toBe(false);
  });

  it('shapeFinancialFieldsList applies the same redaction across an array', () => {
    const records: (typeof LOAD_RECORD | typeof READY_TO_INVOICE_RECORD)[] = [
      LOAD_RECORD,
      READY_TO_INVOICE_RECORD,
    ];
    const results = shapeFinancialFieldsList(records, ['DISPATCHER'], OTHER_USER_ID);
    expect(results[0].carrierRate).toBeNull();
    expect((results[1] as typeof READY_TO_INVOICE_RECORD).customerChargesTotal).toBeNull();
  });
});
