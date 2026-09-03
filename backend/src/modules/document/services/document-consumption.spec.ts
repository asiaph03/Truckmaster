import { isDocumentConsumable } from './document-consumption';

describe('isDocumentConsumable — the one shared "allowed for consumption" definition', () => {
  it('CLEAN is consumable', () => {
    expect(isDocumentConsumable('CLEAN')).toBe(true);
  });

  it('SCAN_FAILED is consumable', () => {
    expect(isDocumentConsumable('SCAN_FAILED')).toBe(true);
  });

  it('INFECTED is never consumable', () => {
    expect(isDocumentConsumable('INFECTED')).toBe(false);
  });

  it('PENDING is never consumable', () => {
    expect(isDocumentConsumable('PENDING')).toBe(false);
  });
});
