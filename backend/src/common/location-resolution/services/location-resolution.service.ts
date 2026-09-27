import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface ResolvedLocation {
  lat: number;
  lng: number;
  source: string;
}

/**
 * Dashboard Map Phase 2 — the entire $0-cost resolution strategy: a
 * normalized city/state lookup against GeocodeCache (pre-seeded from
 * the Census Gazetteer — see prisma/seed-data/README.md). No external
 * geocoder call anywhere in this phase; a miss is `null`, never a
 * guessed coordinate. GeocodeCache has no organizationId (see its own
 * schema doc comment) — a plain query, not withTenantTransaction.
 *
 * Shared by both CheckCall and Stop resolution — this service has no
 * concept of which entity called it, by design (Phase 1 revision:
 * "not CheckCall-specific").
 */
@Injectable()
export class LocationResolutionService {
  constructor(private readonly prisma: PrismaService) {}

  buildLookupKey(city: string, state: string): string {
    return `${city.trim().toUpperCase()}|${state.trim().toUpperCase()}`;
  }

  async resolve(city: string, state: string): Promise<ResolvedLocation | null> {
    const lookupKey = this.buildLookupKey(city, state);
    const cached = await this.prisma.geocodeCache.findUnique({ where: { lookupKey } });
    if (!cached) return null;
    return { lat: Number(cached.lat), lng: Number(cached.lng), source: cached.source };
  }
}
