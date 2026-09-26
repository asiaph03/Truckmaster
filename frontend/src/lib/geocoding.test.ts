import { describe, expect, it } from 'vitest';
import { geocodeCityState } from './geocoding';

describe('geocodeCityState — Dashboard Map Phase', () => {
  it('resolves a known city/state pair from the bundled dataset', () => {
    const result = geocodeCityState('Dallas', 'TX');
    expect(result).toEqual({ lat: 32.7767, lng: -96.797 });
  });

  it('is case- and whitespace-insensitive', () => {
    expect(geocodeCityState(' dallas ', ' tx ')).toEqual({ lat: 32.7767, lng: -96.797 });
  });

  it('never confuses two different states’ cities of the same name', () => {
    const newarkNj = geocodeCityState('Newark', 'NJ');
    const stLouisMo = geocodeCityState('St. Louis', 'MO');
    expect(newarkNj).not.toEqual(stLouisMo);
    expect(geocodeCityState('Newark', 'ZZ')).toBeNull();
  });

  it('returns null — never a fabricated coordinate — for a city/state pair not in the dataset', () => {
    expect(geocodeCityState('Nowhereville', 'XX')).toBeNull();
  });
});
