import { LocationResolutionBackfillService } from './location-resolution-backfill.service';

interface MockCheckCall {
  id: string;
  loadId: string;
  locationCity: string | null;
  locationState: string | null;
  resolutionStatus: string;
  occurredAt: Date;
}
interface MockStop {
  id: string;
  loadId: string;
  city: string;
  state: string;
  resolutionStatus: string;
}
interface MockLoad {
  id: string;
  loadNumber: string;
  currentLocationLat: number | null;
  currentLocationLng: number | null;
  currentLocationUpdatedAt: Date | null;
}

function buildService(opts: {
  orgs: { id: string; legalName: string }[];
  data: Record<string, { checkCalls: MockCheckCall[]; stops: MockStop[]; loads: MockLoad[] }>;
  resolveImpl: (
    city: string,
    state: string,
  ) => Promise<{ lat: number; lng: number; source: string } | null>;
}) {
  const prisma = {
    organization: { findMany: jest.fn().mockResolvedValue(opts.orgs) },
    withTenantTransaction: jest
      .fn()
      .mockImplementation((orgId: string, fn: (tx: unknown) => unknown) => {
        const orgData = opts.data[orgId] ?? { checkCalls: [], stops: [], loads: [] };
        const tx = {
          checkCall: { findMany: jest.fn().mockResolvedValue(orgData.checkCalls) },
          stop: { findMany: jest.fn().mockResolvedValue(orgData.stops) },
          load: { findMany: jest.fn().mockResolvedValue(orgData.loads) },
        };
        return fn(tx);
      }),
  };
  const locationResolution = { resolve: jest.fn().mockImplementation(opts.resolveImpl) };
  const service = new LocationResolutionBackfillService(
    prisma as never,
    locationResolution as never,
  );
  return { service, prisma, locationResolution };
}

const ORG = { id: 'org-1', legalName: 'Org One' };

describe('LocationResolutionBackfillService', () => {
  describe('cache hit', () => {
    it('counts a resolvable unresolved CheckCall as a cache hit / would-resolve, in dry-run with zero enqueues', async () => {
      const { service, prisma } = buildService({
        orgs: [ORG],
        data: {
          [ORG.id]: {
            checkCalls: [
              {
                id: 'cc-1',
                loadId: 'load-1',
                locationCity: 'Tulsa',
                locationState: 'OK',
                resolutionStatus: 'UNRESOLVED',
                occurredAt: new Date('2026-01-01T00:00:00Z'),
              },
            ],
            stops: [],
            loads: [
              {
                id: 'load-1',
                loadNumber: 'LOAD-1',
                currentLocationLat: null,
                currentLocationLng: null,
                currentLocationUpdatedAt: new Date('2026-01-01T00:05:00Z'),
              },
            ],
          },
        },
        resolveImpl: async () => ({ lat: 36.15, lng: -95.99, source: 'census-gazetteer' }),
      });

      const report = await service.run({ dryRun: true });

      expect(report.totals.checkCalls).toEqual({
        totalUnresolvedExamined: 1,
        usableCityState: 1,
        cacheHits: 1,
        wouldResolve: 1,
        wouldRemainUnresolved: 0,
      });
      expect(report.totals.loads.wouldReceiveCoordinates).toBe(1);
      expect(report.jobsEnqueued).toBe(0);
      expect(prisma.withTenantTransaction).toHaveBeenCalledWith(ORG.id, expect.any(Function));
    });
  });

  describe('cache miss', () => {
    it('counts an unresolvable unresolved CheckCall as would-remain-unresolved, never guessing a coordinate', async () => {
      const { service } = buildService({
        orgs: [ORG],
        data: {
          [ORG.id]: {
            checkCalls: [
              {
                id: 'cc-1',
                loadId: 'load-1',
                locationCity: 'Nowhereville',
                locationState: 'ZZ',
                resolutionStatus: 'UNRESOLVED',
                occurredAt: new Date('2026-01-01T00:00:00Z'),
              },
            ],
            stops: [],
            loads: [
              {
                id: 'load-1',
                loadNumber: 'LOAD-1',
                currentLocationLat: null,
                currentLocationLng: null,
                currentLocationUpdatedAt: new Date(),
              },
            ],
          },
        },
        resolveImpl: async () => null,
      });

      const report = await service.run({ dryRun: true });

      expect(report.totals.checkCalls.wouldResolve).toBe(0);
      expect(report.totals.checkCalls.wouldRemainUnresolved).toBe(1);
      expect(report.totals.loads.wouldReceiveCoordinates).toBe(0);
      expect(report.totals.loads.noApplicableLatestCheckCall).toBe(1);
    });
  });

  describe('RLS/tenant isolation', () => {
    it('runs each organization inside its own withTenantTransaction call and never mixes data across orgs', async () => {
      const orgA = { id: 'org-a', legalName: 'Org A' };
      const orgB = { id: 'org-b', legalName: 'Org B' };
      const { service, prisma } = buildService({
        orgs: [orgA, orgB],
        data: {
          [orgA.id]: {
            checkCalls: [
              {
                id: 'cc-a',
                loadId: 'load-a',
                locationCity: 'Tulsa',
                locationState: 'OK',
                resolutionStatus: 'UNRESOLVED',
                occurredAt: new Date(),
              },
            ],
            stops: [],
            loads: [],
          },
          [orgB.id]: { checkCalls: [], stops: [], loads: [] },
        },
        resolveImpl: async () => ({ lat: 1, lng: 2, source: 'census-gazetteer' }),
      });

      const report = await service.run({ dryRun: true });

      expect(prisma.withTenantTransaction).toHaveBeenCalledTimes(2);
      expect(prisma.withTenantTransaction).toHaveBeenNthCalledWith(
        1,
        orgA.id,
        expect.any(Function),
      );
      expect(prisma.withTenantTransaction).toHaveBeenNthCalledWith(
        2,
        orgB.id,
        expect.any(Function),
      );

      const orgAResult = report.perOrganization.find((o) => o.organizationId === orgA.id)!;
      const orgBResult = report.perOrganization.find((o) => o.organizationId === orgB.id)!;
      expect(orgAResult.checkCalls.totalUnresolvedExamined).toBe(1);
      expect(orgBResult.checkCalls.totalUnresolvedExamined).toBe(0);
    });
  });

  describe('stale CheckCall protection', () => {
    it('only the latest CheckCall for a Load is eligible to write Load coordinates — an older, resolvable CheckCall is flagged stale and blocked', async () => {
      const { service } = buildService({
        orgs: [ORG],
        data: {
          [ORG.id]: {
            checkCalls: [
              {
                id: 'cc-old',
                loadId: 'load-1',
                locationCity: 'Tulsa',
                locationState: 'OK',
                resolutionStatus: 'UNRESOLVED',
                occurredAt: new Date('2026-01-01T00:00:00Z'),
              },
              {
                id: 'cc-new',
                loadId: 'load-1',
                locationCity: 'Dallas',
                locationState: 'TX',
                resolutionStatus: 'UNRESOLVED',
                occurredAt: new Date('2026-01-02T00:00:00Z'),
              },
            ],
            stops: [],
            loads: [
              {
                id: 'load-1',
                loadNumber: 'LOAD-1',
                currentLocationLat: null,
                currentLocationLng: null,
                currentLocationUpdatedAt: new Date('2026-01-02T00:05:00Z'),
              },
            ],
          },
        },
        resolveImpl: async () => ({ lat: 1, lng: 2, source: 'census-gazetteer' }),
      });

      const report = await service.run({ dryRun: true });

      // Both CheckCalls individually resolve (their own rows), but only
      // the newer one (cc-new) is eligible to write the Load.
      expect(report.totals.checkCalls.wouldResolve).toBe(2);
      expect(report.totals.loads.wouldReceiveCoordinates).toBe(1);
      expect(report.totals.loads.skippedStaleCheckCall).toBe(1);
      expect(report.samples.loadStaleGuarded).toEqual({
        organizationId: ORG.id,
        loadId: 'load-1',
        loadNumber: 'LOAD-1',
      });
    });

    it('never enqueues asOfLoadUpdatedAt for a stale (non-latest) CheckCall, so the worker can never write Load from it', async () => {
      const { service } = buildService({
        orgs: [ORG],
        data: {
          [ORG.id]: {
            checkCalls: [
              {
                id: 'cc-old',
                loadId: 'load-1',
                locationCity: 'Tulsa',
                locationState: 'OK',
                resolutionStatus: 'UNRESOLVED',
                occurredAt: new Date('2026-01-01T00:00:00Z'),
              },
              {
                id: 'cc-new',
                loadId: 'load-1',
                locationCity: 'Dallas',
                locationState: 'TX',
                resolutionStatus: 'UNRESOLVED',
                occurredAt: new Date('2026-01-02T00:00:00Z'),
              },
            ],
            stops: [],
            loads: [
              {
                id: 'load-1',
                loadNumber: 'LOAD-1',
                currentLocationLat: null,
                currentLocationLng: null,
                currentLocationUpdatedAt: new Date('2026-01-02T00:05:00Z'),
              },
            ],
          },
        },
        resolveImpl: async () => ({ lat: 1, lng: 2, source: 'census-gazetteer' }),
      });

      const queue = { add: jest.fn().mockResolvedValue(undefined), close: jest.fn() };
      await service.run({ dryRun: false, queue: queue as never });

      const oldJob = queue.add.mock.calls.find((c) => c[1].entityId === 'cc-old')![1];
      const newJob = queue.add.mock.calls.find((c) => c[1].entityId === 'cc-new')![1];
      expect(oldJob.asOfLoadUpdatedAt).toBeUndefined();
      expect(newJob.asOfLoadUpdatedAt).toBe('2026-01-02T00:05:00.000Z');
    });
  });

  describe('already-resolved records', () => {
    it('excludes an already RESOLVED_DATASET CheckCall/Stop from the unresolved-examined counts entirely', async () => {
      const { service } = buildService({
        orgs: [ORG],
        data: {
          [ORG.id]: {
            checkCalls: [
              {
                id: 'cc-done',
                loadId: 'load-1',
                locationCity: 'Tulsa',
                locationState: 'OK',
                resolutionStatus: 'RESOLVED_DATASET',
                occurredAt: new Date(),
              },
            ],
            stops: [
              {
                id: 'stop-done',
                loadId: 'load-1',
                city: 'Tulsa',
                state: 'OK',
                resolutionStatus: 'RESOLVED_DATASET',
              },
            ],
            loads: [],
          },
        },
        resolveImpl: async () => ({ lat: 1, lng: 2, source: 'census-gazetteer' }),
      });

      const report = await service.run({ dryRun: true });

      expect(report.totals.checkCalls.totalUnresolvedExamined).toBe(0);
      expect(report.totals.stops.totalUnresolvedExamined).toBe(0);
    });

    it('does not re-enqueue or re-examine a Load that already has coordinates', async () => {
      const { service } = buildService({
        orgs: [ORG],
        data: {
          [ORG.id]: {
            checkCalls: [
              {
                id: 'cc-1',
                loadId: 'load-1',
                locationCity: 'Tulsa',
                locationState: 'OK',
                resolutionStatus: 'UNRESOLVED',
                occurredAt: new Date(),
              },
            ],
            stops: [],
            loads: [
              {
                id: 'load-1',
                loadNumber: 'LOAD-1',
                currentLocationLat: 36.15,
                currentLocationLng: -95.99,
                currentLocationUpdatedAt: new Date(),
              },
            ],
          },
        },
        resolveImpl: async () => ({ lat: 36.15, lng: -95.99, source: 'census-gazetteer' }),
      });

      const report = await service.run({ dryRun: true });

      expect(report.totals.loads.alreadyHavingCoordinates).toBe(1);
      expect(report.totals.loads.wouldReceiveCoordinates).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('produces the identical report when run twice in a row against the same (unchanged) data', async () => {
      const buildData = () => ({
        orgs: [ORG],
        data: {
          [ORG.id]: {
            checkCalls: [
              {
                id: 'cc-1',
                loadId: 'load-1',
                locationCity: 'Tulsa',
                locationState: 'OK',
                resolutionStatus: 'UNRESOLVED',
                occurredAt: new Date('2026-01-01T00:00:00Z'),
              },
            ],
            stops: [],
            loads: [
              {
                id: 'load-1',
                loadNumber: 'LOAD-1',
                currentLocationLat: null,
                currentLocationLng: null,
                currentLocationUpdatedAt: new Date('2026-01-01T00:05:00Z'),
              },
            ],
          },
        },
        resolveImpl: async () => ({ lat: 36.15, lng: -95.99, source: 'census-gazetteer' as const }),
      });

      const first = buildService(buildData());
      const second = buildService(buildData());

      const reportA = await first.service.run({ dryRun: true });
      const reportB = await second.service.run({ dryRun: true });

      expect(reportA.totals).toEqual(reportB.totals);
    });

    it('BullMQ job IDs are hyphen-based and deterministic per entity, so a rerun targets the same job (dedup-safe)', async () => {
      const { service } = buildService({
        orgs: [ORG],
        data: {
          [ORG.id]: {
            checkCalls: [
              {
                id: 'cc-1',
                loadId: 'load-1',
                locationCity: 'Tulsa',
                locationState: 'OK',
                resolutionStatus: 'UNRESOLVED',
                occurredAt: new Date(),
              },
            ],
            stops: [],
            loads: [],
          },
        },
        resolveImpl: async () => ({ lat: 1, lng: 2, source: 'census-gazetteer' }),
      });

      const queue = { add: jest.fn().mockResolvedValue(undefined) };
      await service.run({ dryRun: false, queue: queue as never });

      expect(queue.add).toHaveBeenCalledWith(
        'resolve',
        expect.objectContaining({ entityType: 'CHECK_CALL', entityId: 'cc-1' }),
        expect.objectContaining({ jobId: 'CHECK_CALL-cc-1' }),
      );
    });
  });

  describe('dry-run produces no writes', () => {
    it('never calls queue.add in dry-run mode even when a queue instance is passed', async () => {
      const { service } = buildService({
        orgs: [ORG],
        data: {
          [ORG.id]: {
            checkCalls: [
              {
                id: 'cc-1',
                loadId: 'load-1',
                locationCity: 'Tulsa',
                locationState: 'OK',
                resolutionStatus: 'UNRESOLVED',
                occurredAt: new Date(),
              },
            ],
            stops: [
              {
                id: 'stop-1',
                loadId: 'load-1',
                city: 'Dallas',
                state: 'TX',
                resolutionStatus: 'UNRESOLVED',
              },
            ],
            loads: [],
          },
        },
        resolveImpl: async () => ({ lat: 1, lng: 2, source: 'census-gazetteer' }),
      });

      const queue = { add: jest.fn() };
      const report = await service.run({ dryRun: true, queue: queue as never });

      expect(queue.add).not.toHaveBeenCalled();
      expect(report.jobsEnqueued).toBe(0);
    });

    it('never mutates any tx model — only findMany is ever called on checkCall/stop/load', async () => {
      const orgData = {
        checkCalls: [
          {
            id: 'cc-1',
            loadId: 'load-1',
            locationCity: 'Tulsa',
            locationState: 'OK',
            resolutionStatus: 'UNRESOLVED',
            occurredAt: new Date(),
          },
        ],
        stops: [],
        loads: [],
      };
      const prisma = {
        organization: { findMany: jest.fn().mockResolvedValue([ORG]) },
        withTenantTransaction: jest
          .fn()
          .mockImplementation((orgId: string, fn: (tx: unknown) => unknown) => {
            const tx = {
              checkCall: {
                findMany: jest.fn().mockResolvedValue(orgData.checkCalls),
                update: jest.fn(),
                updateMany: jest.fn(),
              },
              stop: {
                findMany: jest.fn().mockResolvedValue(orgData.stops),
                update: jest.fn(),
                updateMany: jest.fn(),
              },
              load: {
                findMany: jest.fn().mockResolvedValue(orgData.loads),
                update: jest.fn(),
                updateMany: jest.fn(),
              },
            };
            return (fn(tx) as Promise<unknown>).then((result: unknown) => {
              expect(tx.checkCall.update).not.toHaveBeenCalled();
              expect(tx.checkCall.updateMany).not.toHaveBeenCalled();
              expect(tx.stop.update).not.toHaveBeenCalled();
              expect(tx.stop.updateMany).not.toHaveBeenCalled();
              expect(tx.load.update).not.toHaveBeenCalled();
              expect(tx.load.updateMany).not.toHaveBeenCalled();
              return result;
            });
          }),
      };
      const locationResolution = {
        resolve: jest.fn().mockResolvedValue({ lat: 1, lng: 2, source: 'census-gazetteer' }),
      };
      const service = new LocationResolutionBackfillService(
        prisma as never,
        locationResolution as never,
      );

      await service.run({ dryRun: true });

      expect.assertions(6);
    });
  });
});
