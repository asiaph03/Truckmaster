import { describe, expect, it } from 'vitest';
import { isDocumentConsumable } from './documents';

describe('isDocumentConsumable — shared frontend document-consumption predicate', () => {
  it('CLEAN is consumable', () => {
    expect(isDocumentConsumable('CLEAN')).toBe(true);
  });

  it('SCAN_FAILED is consumable (approved policy: a failed scan attempt does not block usage)', () => {
    expect(isDocumentConsumable('SCAN_FAILED')).toBe(true);
  });

  it('INFECTED is not consumable (remains blocked)', () => {
    expect(isDocumentConsumable('INFECTED')).toBe(false);
  });

  it('PENDING is not consumable (remains blocked)', () => {
    expect(isDocumentConsumable('PENDING')).toBe(false);
  });
});
