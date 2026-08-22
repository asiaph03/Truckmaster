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

  it('grants manageCustomers to Admin/OpsManager/Sales/Accounting but not Dispatcher', () => {
    expect(roleHasPermission(['ADMIN'], 'manageCustomers')).toBe(true);
    expect(roleHasPermission(['OPERATIONS_MANAGER'], 'manageCustomers')).toBe(true);
    expect(roleHasPermission(['SALES_BOOKING'], 'manageCustomers')).toBe(true);
    expect(roleHasPermission(['ACCOUNTING'], 'manageCustomers')).toBe(true);
    expect(roleHasPermission(['DISPATCHER'], 'manageCustomers')).toBe(false);
  });

  it('grants manageCarriers to Admin/OpsManager/Dispatcher but not Sales/Accounting', () => {
    expect(roleHasPermission(['ADMIN'], 'manageCarriers')).toBe(true);
    expect(roleHasPermission(['OPERATIONS_MANAGER'], 'manageCarriers')).toBe(true);
    expect(roleHasPermission(['DISPATCHER'], 'manageCarriers')).toBe(true);
    expect(roleHasPermission(['SALES_BOOKING'], 'manageCarriers')).toBe(false);
    expect(roleHasPermission(['ACCOUNTING'], 'manageCarriers')).toBe(false);
  });

  it('grants addCarrierInsurance to the same 3 base roles plus Compliance Reviewer', () => {
    expect(roleHasPermission(['ADMIN'], 'addCarrierInsurance')).toBe(true);
    expect(roleHasPermission(['OPERATIONS_MANAGER'], 'addCarrierInsurance')).toBe(true);
    expect(roleHasPermission(['DISPATCHER'], 'addCarrierInsurance')).toBe(true);
    expect(roleHasPermission(['COMPLIANCE_REVIEWER'], 'addCarrierInsurance')).toBe(true);
    expect(roleHasPermission(['SALES_BOOKING'], 'addCarrierInsurance')).toBe(false);
    expect(roleHasPermission(['ACCOUNTING'], 'addCarrierInsurance')).toBe(false);
  });

  it('restricts reviewComplianceDocuments, recordFmcsaVerification, and activateCarrier to Compliance Reviewer only — no Admin override', () => {
    // Backend: @Roles('COMPLIANCE_REVIEWER') exclusively on all three
    // (document.controller.ts, carrier.controller.ts) — a segregation-
    // of-duties control Admin does NOT bypass. Caught during Phase 2
    // manual verification: Admin's list previously (incorrectly)
    // included 'reviewComplianceDocuments', which would have rendered
    // Approve/Reject buttons that 403 on click.
    expect(roleHasPermission(['COMPLIANCE_REVIEWER'], 'reviewComplianceDocuments')).toBe(true);
    expect(roleHasPermission(['COMPLIANCE_REVIEWER'], 'recordFmcsaVerification')).toBe(true);
    expect(roleHasPermission(['COMPLIANCE_REVIEWER'], 'activateCarrier')).toBe(true);
    for (const role of [
      'ADMIN',
      'OPERATIONS_MANAGER',
      'DISPATCHER',
      'SALES_BOOKING',
      'ACCOUNTING',
    ] as const) {
      expect(roleHasPermission([role], 'reviewComplianceDocuments')).toBe(false);
      expect(roleHasPermission([role], 'recordFmcsaVerification')).toBe(false);
      expect(roleHasPermission([role], 'activateCarrier')).toBe(false);
    }
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
