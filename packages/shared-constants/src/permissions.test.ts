import { describe, expect, it } from 'vitest';
import { roleHasPermission, NAV_VISIBILITY } from './permissions';

describe('roleHasPermission', () => {
  it('grants full-visibility financial permission to Admin/OpsManager/Accounting', () => {
    expect(roleHasPermission(['ADMIN'], 'viewLoadFinancials')).toBe(true);
    expect(roleHasPermission(['OPERATIONS_MANAGER'], 'viewLoadFinancials')).toBe(true);
    expect(roleHasPermission(['ACCOUNTING'], 'viewLoadFinancials')).toBe(true);
  });

  it('denies load financials to Dispatcher and Sales/Booking', () => {
    expect(roleHasPermission(['DISPATCHER'], 'viewLoadFinancials')).toBe(false);
    expect(roleHasPermission(['SALES_BOOKING'], 'viewLoadFinancials')).toBe(false);
  });

  it('grants sendOrVoidInvoice only to Admin and Accounting, not OpsManager', () => {
    expect(roleHasPermission(['ADMIN'], 'sendOrVoidInvoice')).toBe(true);
    expect(roleHasPermission(['ACCOUNTING'], 'sendOrVoidInvoice')).toBe(true);
    expect(roleHasPermission(['OPERATIONS_MANAGER'], 'sendOrVoidInvoice')).toBe(false);
  });

  it('is additive across a multi-role membership', () => {
    expect(
      roleHasPermission(['DISPATCHER', 'COMPLIANCE_REVIEWER'], 'reviewComplianceDocuments'),
    ).toBe(true);
    expect(roleHasPermission(['DISPATCHER', 'COMPLIANCE_REVIEWER'], 'viewLoadFinancials')).toBe(
      false,
    );
  });

  it('returns false for an unrecognized/empty role list', () => {
    expect(roleHasPermission([], 'viewLoadFinancials')).toBe(false);
  });
});

describe('NAV_VISIBILITY', () => {
  it('hides Billing entirely for Dispatcher and Settings for everyone but Admin', () => {
    expect(NAV_VISIBILITY.DISPATCHER.billing).toBe(false);
    expect(NAV_VISIBILITY.ADMIN.settings).toBe(true);
    expect(NAV_VISIBILITY.OPERATIONS_MANAGER.settings).toBe(false);
    expect(NAV_VISIBILITY.ACCOUNTING.settings).toBe(false);
  });
});
