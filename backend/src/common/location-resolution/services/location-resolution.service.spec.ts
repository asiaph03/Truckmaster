import { LocationResolutionService } from './location-resolution.service';

describe('LocationResolutionService', () => {
  function buildService(cacheRow: { lat: unknown; lng: unknown; source: string } | null) {
    const geocodeCache = { findUnique: jest.fn().mockResolvedValue(cacheRow) };
    const prisma = { geocodeCache };
    const service = new LocationResolutionService(prisma as never);
    return { service, geocodeCache };
  }

  it('normalizes city/state (trim + uppercase) into the exact GeocodeCache lookup key', () => {
    const { service } = buildService(null);
    expect(service.buildLookupKey('  Tulsa ', ' ok ')).toBe('TULSA|OK');
    expect(service.buildLookupKey('New York', 'ny')).toBe('NEW YORK|NY');
  });

  it('a cache HIT returns {lat, lng, source} — never a guessed value', async () => {
    const { service, geocodeCache } = buildService({
      lat: 36.15,
      lng: -95.99,
      source: 'census-gazetteer',
    });

    const result = await service.resolve('Tulsa', 'OK');

    expect(geocodeCache.findUnique).toHaveBeenCalledWith({ where: { lookupKey: 'TULSA|OK' } });
    expect(result).toEqual({ lat: 36.15, lng: -95.99, source: 'census-gazetteer' });
  });

  it('a cache MISS returns null — never fabricates a coordinate', async () => {
    const { service } = buildService(null);

    const result = await service.resolve('Nowhereville', 'ZZ');

    expect(result).toBeNull();
  });

  it('coerces Prisma Decimal-like lat/lng values to plain numbers', async () => {
    // Prisma returns Decimal fields as objects with their own toString(),
    // not plain numbers — Number(decimal) must still produce a real number.
    const decimalLike = (n: number) => ({ toString: () => String(n), valueOf: () => n });
    const { service } = buildService({
      lat: decimalLike(36.15) as unknown as number,
      lng: decimalLike(-95.99) as unknown as number,
      source: 'census-gazetteer',
    });

    const result = await service.resolve('Tulsa', 'OK');

    expect(result).toEqual({ lat: 36.15, lng: -95.99, source: 'census-gazetteer' });
    expect(typeof result?.lat).toBe('number');
    expect(typeof result?.lng).toBe('number');
  });
});
