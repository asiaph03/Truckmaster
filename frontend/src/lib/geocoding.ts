import { US_CITY_CENTROIDS, type CityCentroid } from './usCityCentroids';

/**
 * Dashboard Map Phase — the entire geocoding strategy for this product:
 * a static, bundled lookup, never a live geocoding API call. A miss
 * returns `null`, never a guessed/fallback coordinate — callers must
 * treat `null` as "cannot be placed on the map", the same way the rest
 * of the product treats an unset location as "unavailable" rather than
 * inventing one.
 */
export function geocodeCityState(city: string, state: string): CityCentroid | null {
  const key = `${city.trim().toUpperCase()}|${state.trim().toUpperCase()}`;
  return US_CITY_CENTROIDS[key] ?? null;
}
