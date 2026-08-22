import { describe, expect, it, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePermissions } from './usePermissions';
import { useSessionStore } from '../auth/session-store';

function setRoles(roles: string[]) {
  useSessionStore.setState({ roles: roles as never });
}

describe('usePermissions', () => {
  beforeEach(() => {
    setRoles([]);
  });

  it('grants full financial visibility to Accounting', () => {
    setRoles(['ACCOUNTING']);
    const { result } = renderHook(() => usePermissions());
    expect(result.current.can('viewLoadFinancials')).toBe(true);
    expect(result.current.isFullVisibility()).toBe(true);
  });

  it('denies Loads-financial visibility and hides Billing nav for Dispatcher', () => {
    setRoles(['DISPATCHER']);
    const { result } = renderHook(() => usePermissions());
    expect(result.current.can('viewLoadFinancials')).toBe(false);
    expect(result.current.canSeeNav('billing')).toBe(false);
    expect(result.current.canSeeNav('loads')).toBe(true);
  });

  it('does not grant a blanket viewLoadFinancials permission to Sales/Booking', () => {
    setRoles(['SALES_BOOKING']);
    const { result } = renderHook(() => usePermissions());
    expect(result.current.can('viewLoadFinancials')).toBe(false);
    expect(result.current.isFullVisibility()).toBe(false);
  });

  it('returns false/hidden for every check with no roles at all', () => {
    const { result } = renderHook(() => usePermissions());
    expect(result.current.can('viewLoadFinancials')).toBe(false);
    expect(result.current.canSeeNav('dashboard')).toBe(false);
  });
});
