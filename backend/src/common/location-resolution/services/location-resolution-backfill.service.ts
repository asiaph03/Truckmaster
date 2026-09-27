import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationResolutionService } from './location-resolution.service';
import {
  LOCATION_RESOLUTION_JOB_OPTIONS,
  LocationResolutionJobData,
} from '../location-resolution.constants';

function usable(city: string | null | undefined, state: string | null | undefined): boolean {
  return !!(city && city.trim().length > 0 && state && state.trim().length > 0);
}

interface CheckCallRow {
  id: string;
  loadId: string;
  locationCity: string | null;
  locationState: string | null;
  resolutionStatus: string;
  occurredAt: Date;
}

export interface BackfillEntityStats {
  totalUnresolvedExamined: number;
  usableCityState: number;
  cacheHits: number;
  wouldResolve: number;
  wouldRemainUnresolved: number;
}

export interface BackfillLoadStats {
  wouldReceiveCoordinates: number;
  skippedStaleCheckCall: number;
  noApplicableLatestCheckCall: number;
  alreadyHavingCoordinates: number;
}

export interface BackfillSampleRef {
  organizationId: string;
  id: string;
  city: string;
  state: string;
}

export interface BackfillLoadSampleRef {
  organizationId: string;
  loadId: string;
  loadNumber: string;
  viaCheckCallId?: string;
}

export interface OrgBackfillResult {
  organizationId: string;
  organizationName: string;
  checkCalls: BackfillEntityStats;
  stops: BackfillEntityStats;
  loads: BackfillLoadStats;
}

export interface BackfillSamples {
  checkCallResolvable?: BackfillSampleRef;
  checkCallUnresolved?: BackfillSampleRef;
  stopResolvable?: BackfillSampleRef;
  stopUnresolved?: BackfillSampleRef;
  loadReceivingCoordinates?: BackfillLoadSampleRef;
  loadStaleGuarded?: BackfillLoadSampleRef;
}

export interface BackfillReport {
  dryRun: boolean;
  jobsEnqueued: number;
  perOrganization: OrgBackfillResult[];
  totals: {
    checkCalls: BackfillEntityStats;
    stops: BackfillEntityStats;
    loads: BackfillLoadStats;
  };
  samples: BackfillSamples;
}

function emptyEntityStats(): BackfillEntityStats {
  return {
    totalUnresolvedExamined: 0,
    usableCityState: 0,
    cacheHits: 0,
    wouldResolve: 0,
    wouldRemainUnresolved: 0,
  };
}

function emptyLoadStats(): BackfillLoadStats {
  return {
    wouldReceiveCoordinates: 0,
    skippedStaleCheckCall: 0,
    noApplicableLatestCheckCall: 0,
    alreadyHavingCoordinates: 0,
  };
}

function addEntityStats(target: BackfillEntityStats, add: BackfillEntityStats): void {
  target.totalUnresolvedExamined += add.totalUnresolvedExamined;
  target.usableCityState += add.usableCityState;
  target.cacheHits += add.cacheHits;
  target.wouldResolve += add.wouldResolve;
  target.wouldRemainUnresolved += add.wouldRemainUnresolved;
}

function addLoadStats(target: BackfillLoadStats, add: BackfillLoadStats): void {
  target.wouldReceiveCoordinates += add.wouldReceiveCoordinates;
  target.skippedStaleCheckCall += add.skippedStaleCheckCall;
  target.noApplicableLatestCheckCall += add.noApplicableLatestCheckCall;
  target.alreadyHavingCoordinates += add.alreadyHavingCoordinates;
}

/**
 * Dashboard Map Phase 2 — historical backfill for CheckCall/Stop rows that
 * predate this feature (only newly-created rows get auto-enqueued by
 * dispatch-tracking.service.ts / load.service.ts; nothing ever swept the
 * backlog). Deliberately reuses LocationResolutionService.resolve() for
 * every prediction and, in non-dry-run mode, enqueues onto the exact same
 * `resolve-location` BullMQ queue the already-deployed LocationResolutionWorker
 * consumes — this class never calls `.update()`/`.create()` on CheckCall,
 * Stop, Load, or GeocodeCache itself, in EITHER mode. The only difference
 * between dry-run and execute is whether `queue.add(...)` is actually
 * called; every read/prediction path is identical, so a dry-run report is
 * guaranteed to describe exactly what execute would do — no separate
 * simulation logic to keep in sync.
 */
@Injectable()
export class LocationResolutionBackfillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locationResolution: LocationResolutionService,
  ) {}

  async run(options: { dryRun: boolean; queue?: Queue }): Promise<BackfillReport> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true, legalName: true } });

    const perOrganization: OrgBackfillResult[] = [];
    const totals = {
      checkCalls: emptyEntityStats(),
      stops: emptyEntityStats(),
      loads: emptyLoadStats(),
    };
    const samples: BackfillSamples = {};
    let jobsEnqueued = 0;

    for (const org of orgs) {
      const { orgResult, jobs, orgSamples } = await this.prisma.withTenantTransaction(
        org.id,
        (tx) => this.analyzeOrg(tx, org.id, org.legalName),
      );

      perOrganization.push(orgResult);
      addEntityStats(totals.checkCalls, orgResult.checkCalls);
      addEntityStats(totals.stops, orgResult.stops);
      addLoadStats(totals.loads, orgResult.loads);

      samples.checkCallResolvable ??= orgSamples.checkCallResolvable;
      samples.checkCallUnresolved ??= orgSamples.checkCallUnresolved;
      samples.stopResolvable ??= orgSamples.stopResolvable;
      samples.stopUnresolved ??= orgSamples.stopUnresolved;
      samples.loadReceivingCoordinates ??= orgSamples.loadReceivingCoordinates;
      samples.loadStaleGuarded ??= orgSamples.loadStaleGuarded;

      if (!options.dryRun && options.queue) {
        for (const job of jobs) {
          await options.queue.add('resolve', job, {
            ...LOCATION_RESOLUTION_JOB_OPTIONS,
            jobId: `${job.entityType}-${job.entityId}`,
          });
          jobsEnqueued++;
        }
      }
    }

    return { dryRun: options.dryRun, jobsEnqueued, perOrganization, totals, samples };
  }

  /**
   * No createdAt column exists on CheckCall (see schema.prisma's own doc
   * comment on the model) — occurredAt (a business-entered timestamp) is
   * the only available ordering signal, tie-broken deterministically by id
   * when two rows share the exact same occurredAt. This mirrors, as
   * closely as the data allows, the "creation order" semantic
   * logCheckCall() already uses live for Load's denormalized city/state.
   */
  private latestCheckCallPerLoad(checkCalls: CheckCallRow[]): Map<string, string> {
    const latest = new Map<string, CheckCallRow>();
    for (const c of checkCalls) {
      const current = latest.get(c.loadId);
      if (!current) {
        latest.set(c.loadId, c);
        continue;
      }
      const cTime = c.occurredAt.getTime();
      const curTime = current.occurredAt.getTime();
      if (cTime > curTime || (cTime === curTime && c.id < current.id)) {
        latest.set(c.loadId, c);
      }
    }
    const result = new Map<string, string>();
    for (const [loadId, c] of latest) result.set(loadId, c.id);
    return result;
  }

  private async analyzeOrg(
    tx: Prisma.TransactionClient,
    organizationId: string,
    organizationName: string,
  ): Promise<{
    orgResult: OrgBackfillResult;
    jobs: LocationResolutionJobData[];
    orgSamples: BackfillSamples;
  }> {
    const [checkCalls, stops, loads] = await Promise.all([
      tx.checkCall.findMany({
        select: {
          id: true,
          loadId: true,
          locationCity: true,
          locationState: true,
          resolutionStatus: true,
          occurredAt: true,
        },
      }),
      tx.stop.findMany({
        select: { id: true, loadId: true, city: true, state: true, resolutionStatus: true },
      }),
      tx.load.findMany({
        select: {
          id: true,
          loadNumber: true,
          currentLocationLat: true,
          currentLocationLng: true,
          currentLocationUpdatedAt: true,
        },
      }),
    ]);

    const latestCheckCallIdByLoad = this.latestCheckCallPerLoad(checkCalls);
    const loadById = new Map(loads.map((l) => [l.id, l]));

    // --- CheckCalls ---
    const ccUnresolved = checkCalls.filter((c) => c.resolutionStatus === 'UNRESOLVED');
    const ccUsable = ccUnresolved.filter((c) => usable(c.locationCity, c.locationState));
    const ccStats = emptyEntityStats();
    ccStats.totalUnresolvedExamined = ccUnresolved.length;
    ccStats.usableCityState = ccUsable.length;

    const ccResolvedById = new Map<string, boolean>();
    const staleLoads = new Set<string>();
    const jobs: LocationResolutionJobData[] = [];
    let checkCallResolvable: BackfillSampleRef | undefined;
    let checkCallUnresolved: BackfillSampleRef | undefined;

    for (const c of ccUsable) {
      const city = c.locationCity as string;
      const state = c.locationState as string;
      const resolved = await this.locationResolution.resolve(city, state);
      const isLatest = latestCheckCallIdByLoad.get(c.loadId) === c.id;
      ccResolvedById.set(c.id, !!resolved);
      if (!isLatest) staleLoads.add(c.loadId);

      if (resolved) {
        ccStats.cacheHits++;
        ccStats.wouldResolve++;
        checkCallResolvable ??= { organizationId, id: c.id, city, state };
      } else {
        ccStats.wouldRemainUnresolved++;
        checkCallUnresolved ??= { organizationId, id: c.id, city, state };
      }

      const load = loadById.get(c.loadId);
      jobs.push({
        entityType: 'CHECK_CALL',
        entityId: c.id,
        organizationId,
        city,
        state,
        asOfLoadUpdatedAt: isLatest
          ? (load?.currentLocationUpdatedAt?.toISOString() ?? undefined)
          : undefined,
      });
    }

    // --- Stops (no Load-level race guard — each Stop is its own row) ---
    const stUnresolved = stops.filter((s) => s.resolutionStatus === 'UNRESOLVED');
    const stUsable = stUnresolved.filter((s) => usable(s.city, s.state));
    const stStats = emptyEntityStats();
    stStats.totalUnresolvedExamined = stUnresolved.length;
    stStats.usableCityState = stUsable.length;

    let stopResolvable: BackfillSampleRef | undefined;
    let stopUnresolved: BackfillSampleRef | undefined;

    for (const s of stUsable) {
      const resolved = await this.locationResolution.resolve(s.city, s.state);
      if (resolved) {
        stStats.cacheHits++;
        stStats.wouldResolve++;
        stopResolvable ??= { organizationId, id: s.id, city: s.city, state: s.state };
      } else {
        stStats.wouldRemainUnresolved++;
        stopUnresolved ??= { organizationId, id: s.id, city: s.city, state: s.state };
      }
      jobs.push({
        entityType: 'STOP',
        entityId: s.id,
        organizationId,
        city: s.city,
        state: s.state,
      });
    }

    // --- Loads ---
    const loadStats = emptyLoadStats();
    let loadReceivingCoordinates: BackfillLoadSampleRef | undefined;
    let loadStaleGuarded: BackfillLoadSampleRef | undefined;

    for (const load of loads) {
      if (load.currentLocationLat != null && load.currentLocationLng != null) {
        loadStats.alreadyHavingCoordinates++;
      } else {
        const latestId = latestCheckCallIdByLoad.get(load.id);
        const latestCheckCall = latestId ? checkCalls.find((c) => c.id === latestId) : undefined;

        if (
          latestCheckCall &&
          latestCheckCall.resolutionStatus === 'UNRESOLVED' &&
          usable(latestCheckCall.locationCity, latestCheckCall.locationState) &&
          ccResolvedById.get(latestCheckCall.id)
        ) {
          loadStats.wouldReceiveCoordinates++;
          loadReceivingCoordinates ??= {
            organizationId,
            loadId: load.id,
            loadNumber: load.loadNumber,
            viaCheckCallId: latestCheckCall.id,
          };
        } else {
          // No CheckCall at all, the latest one lacks usable city/state, the
          // latest one was already settled by the live worker with a
          // different outcome, or the latest one is a cache miss — in every
          // case, nothing available today would give this Load coordinates.
          loadStats.noApplicableLatestCheckCall++;
        }
      }

      if (staleLoads.has(load.id)) {
        loadStats.skippedStaleCheckCall++;
        loadStaleGuarded ??= { organizationId, loadId: load.id, loadNumber: load.loadNumber };
      }
    }

    return {
      orgResult: {
        organizationId,
        organizationName,
        checkCalls: ccStats,
        stops: stStats,
        loads: loadStats,
      },
      jobs,
      orgSamples: {
        checkCallResolvable,
        checkCallUnresolved,
        stopResolvable,
        stopUnresolved,
        loadReceivingCoordinates,
        loadStaleGuarded,
      },
    };
  }
}
