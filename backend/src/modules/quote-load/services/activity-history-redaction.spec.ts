import { redactAuditFinancialFields } from './activity-history-redaction';

const OWNER_ID = 'user-owner';
const OTHER_USER_ID = 'user-other';

/** Test fixtures store `newValue` as `unknown` (matching the real AuditLog JSON column) — narrow it once here rather than `as any` at each assertion. */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// One fixture per real financial audit-action shape, per the enumeration
// done during Phase 7 planning (grep of every audit.record() call with
// entityType: 'Load').
const LOAD_BOOKED_ENTRY = {
  action: 'Load Booked Directly (No Quote)',
  previousValue: null,
  newValue: { customerRate: '1800.00', rateSource: 'MANUAL' },
};

const CARRIER_ASSIGNED_ENTRY = {
  action: 'Carrier Assigned',
  previousValue: null,
  newValue: { carrierId: 'carrier-1', carrierRate: '1500.00' },
};

const CHARGE_ADDED_CUSTOMER_ENTRY = {
  action: 'Charge Line Item Added',
  previousValue: null,
  newValue: { side: 'CUSTOMER', amount: '250.00', description: 'Detention' },
};

const CHARGE_ADDED_CARRIER_ENTRY = {
  action: 'Charge Line Item Added',
  previousValue: null,
  newValue: { side: 'CARRIER', amount: '200.00', description: 'Lumper' },
};

const LOAD_CLOSED_ENTRY = {
  action: 'Load Closed',
  previousValue: null,
  newValue: {
    checklistSnapshot: [{ item: 'POD Received', remainingCarrierBalance: '1500.00' }],
  },
};

const NON_FINANCIAL_ENTRY = {
  action: 'Risk Status Changed',
  previousValue: { riskStatus: 'NORMAL' },
  newValue: { riskStatus: 'AT_RISK', riskReason: 'Weather delay' },
};

type Scenario = {
  label: string;
  roles: ('ADMIN' | 'OPERATIONS_MANAGER' | 'DISPATCHER' | 'SALES_BOOKING' | 'ACCOUNTING')[];
  actingUserId: string;
};

const ALL_SCENARIOS: Scenario[] = [
  { label: 'Admin', roles: ['ADMIN'], actingUserId: OTHER_USER_ID },
  { label: 'Operations Manager', roles: ['OPERATIONS_MANAGER'], actingUserId: OTHER_USER_ID },
  { label: 'Dispatcher', roles: ['DISPATCHER'], actingUserId: OTHER_USER_ID },
  { label: 'Owning Sales/Booking', roles: ['SALES_BOOKING'], actingUserId: OWNER_ID },
  { label: 'Non-owning Sales/Booking', roles: ['SALES_BOOKING'], actingUserId: OTHER_USER_ID },
];

describe('redactAuditFinancialFields — Frontend Phase 7 (Activity History, LD-6)', () => {
  describe('customer-side field (Load Booked → customerRate)', () => {
    it.each(ALL_SCENARIOS)('$label', ({ roles, actingUserId }) => {
      const result = redactAuditFinancialFields(LOAD_BOOKED_ENTRY, roles, actingUserId, OWNER_ID);
      const showCustomerSide =
        roles.includes('ADMIN') ||
        roles.includes('OPERATIONS_MANAGER') ||
        roles.includes('ACCOUNTING') ||
        (roles.includes('SALES_BOOKING') && actingUserId === OWNER_ID);
      expect(asRecord(result.newValue).customerRate).toBe(showCustomerSide ? '1800.00' : null);
    });
  });

  describe('carrier-side field (Carrier Assigned → carrierRate)', () => {
    it.each(ALL_SCENARIOS)('$label', ({ roles, actingUserId }) => {
      const result = redactAuditFinancialFields(
        CARRIER_ASSIGNED_ENTRY,
        roles,
        actingUserId,
        OWNER_ID,
      );
      const showCarrierSide =
        roles.includes('ADMIN') ||
        roles.includes('OPERATIONS_MANAGER') ||
        roles.includes('ACCOUNTING');
      expect(asRecord(result.newValue).carrierRate).toBe(showCarrierSide ? '1500.00' : null);
      // Non-financial sibling field always survives.
      expect(asRecord(result.newValue).carrierId).toBe('carrier-1');
    });
  });

  describe('per-item side-gated field (Charge Line Item Added → amount)', () => {
    it.each(ALL_SCENARIOS)('$label — CUSTOMER-side charge', ({ roles, actingUserId }) => {
      const result = redactAuditFinancialFields(
        CHARGE_ADDED_CUSTOMER_ENTRY,
        roles,
        actingUserId,
        OWNER_ID,
      );
      const showCustomerSide =
        roles.includes('ADMIN') ||
        roles.includes('OPERATIONS_MANAGER') ||
        roles.includes('ACCOUNTING') ||
        (roles.includes('SALES_BOOKING') && actingUserId === OWNER_ID);
      expect(asRecord(result.newValue).amount).toBe(showCustomerSide ? '250.00' : null);
    });

    it.each(ALL_SCENARIOS)('$label — CARRIER-side charge', ({ roles, actingUserId }) => {
      const result = redactAuditFinancialFields(
        CHARGE_ADDED_CARRIER_ENTRY,
        roles,
        actingUserId,
        OWNER_ID,
      );
      const showCarrierSide =
        roles.includes('ADMIN') ||
        roles.includes('OPERATIONS_MANAGER') ||
        roles.includes('ACCOUNTING');
      expect(asRecord(result.newValue).amount).toBe(showCarrierSide ? '200.00' : null);
    });
  });

  describe('nested array field (Load Closed → checklistSnapshot[].remainingCarrierBalance)', () => {
    it.each(ALL_SCENARIOS)('$label', ({ roles, actingUserId }) => {
      const result = redactAuditFinancialFields(LOAD_CLOSED_ENTRY, roles, actingUserId, OWNER_ID);
      const showCarrierSide =
        roles.includes('ADMIN') ||
        roles.includes('OPERATIONS_MANAGER') ||
        roles.includes('ACCOUNTING');
      const snapshot = asRecord(result.newValue).checklistSnapshot as Record<string, unknown>[];
      expect(snapshot[0].remainingCarrierBalance).toBe(showCarrierSide ? '1500.00' : null);
      // Non-financial sibling field always survives.
      expect(snapshot[0].item).toBe('POD Received');
    });
  });

  it('leaves a non-financial entry completely untouched for the most restricted role', () => {
    const result = redactAuditFinancialFields(
      NON_FINANCIAL_ENTRY,
      ['DISPATCHER'],
      OTHER_USER_ID,
      OWNER_ID,
    );
    expect(result).toEqual(NON_FINANCIAL_ENTRY);
  });

  it('returns the exact same entry reference when full visibility applies (no redaction needed)', () => {
    const result = redactAuditFinancialFields(
      CARRIER_ASSIGNED_ENTRY,
      ['ADMIN'],
      OTHER_USER_ID,
      OWNER_ID,
    );
    expect(result).toBe(CARRIER_ASSIGNED_ENTRY);
  });

  it('never mutates the original stored entry object — redaction is copy-on-write', () => {
    const original = JSON.parse(JSON.stringify(CARRIER_ASSIGNED_ENTRY));
    redactAuditFinancialFields(CARRIER_ASSIGNED_ENTRY, ['DISPATCHER'], OTHER_USER_ID, OWNER_ID);
    expect(CARRIER_ASSIGNED_ENTRY).toEqual(original);
  });
});
