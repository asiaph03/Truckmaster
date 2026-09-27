import { LocationResolutionWorker } from './location-resolution.worker';

type Processor = (job: {
  id?: string;
  data: {
    entityType: 'CHECK_CALL' | 'STOP';
    entityId: string;
    organizationId: string;
    city: string;
    state: string;
    asOfLoadUpdatedAt?: string;
  };
  attemptsMade: number;
  opts: { attempts?: number };
}) => Promise<void>;

let capturedProcessor: Processor | undefined;

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name: string, processor: Processor) => {
    capturedProcessor = processor;
    return { on: jest.fn(), close: jest.fn(), isRunning: () => true };
  }),
}));

describe('LocationResolutionWorker', () => {
  const ORG_ID = 'org-1';

  function buildWorker(resolveResult: { lat: number; lng: number; source: string } | null) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const checkCall = { update: jest.fn().mockResolvedValue({ loadId: 'load-1' }) };
    const load = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    const stop = { update: jest.fn().mockResolvedValue({}) };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) =>
          fn({ checkCall, load, stop }),
        ),
    };
    const locationResolution = { resolve: jest.fn().mockResolvedValue(resolveResult) };
    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };

    const worker = new LocationResolutionWorker(
      redis as never,
      prisma as never,
      locationResolution as never,
      heartbeat as never,
    );
    worker.onModuleInit();
    if (!capturedProcessor) throw new Error('Worker processor was not captured');
    const processor: Processor = capturedProcessor;
    return { processor, prisma, checkCall, load, stop, locationResolution, heartbeat };
  }

  describe('CHECK_CALL entity', () => {
    const JOB_DATA = {
      entityType: 'CHECK_CALL' as const,
      entityId: 'checkcall-1',
      organizationId: ORG_ID,
      city: 'Tulsa',
      state: 'OK',
      asOfLoadUpdatedAt: '2026-09-01T00:00:00.000Z',
    };

    it('a dataset HIT writes resolved coordinates to the CheckCall and, guarded, to the Load', async () => {
      const { processor, checkCall, load, locationResolution } = buildWorker({
        lat: 36.15,
        lng: -95.99,
        source: 'census-gazetteer',
      });

      await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

      expect(locationResolution.resolve).toHaveBeenCalledWith('Tulsa', 'OK');
      expect(checkCall.update).toHaveBeenCalledWith({
        where: { id: 'checkcall-1' },
        data: expect.objectContaining({
          resolvedLat: 36.15,
          resolvedLng: -95.99,
          resolutionStatus: 'RESOLVED_DATASET',
          resolutionSource: 'census-gazetteer',
        }),
        select: { loadId: true },
      });
      expect(load.updateMany).toHaveBeenCalledWith({
        where: { id: 'load-1', currentLocationUpdatedAt: new Date(JOB_DATA.asOfLoadUpdatedAt) },
        data: { currentLocationLat: 36.15, currentLocationLng: -95.99 },
      });
    });

    it('a dataset MISS marks the CheckCall UNRESOLVED and never touches Load.currentLocationLat/Lng', async () => {
      const { processor, checkCall, load } = buildWorker(null);

      await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

      expect(checkCall.update).toHaveBeenCalledWith({
        where: { id: 'checkcall-1' },
        data: expect.objectContaining({ resolutionStatus: 'UNRESOLVED' }),
        select: { loadId: true },
      });
      expect(load.updateMany).not.toHaveBeenCalled();
    });

    it('race guard: the Load write is scoped to the exact asOfLoadUpdatedAt snapshot, so a newer Check Call already having bumped it makes this write a no-op at the DB level', async () => {
      // updateMany with a non-matching `where` naturally affects 0 rows in
      // real Postgres — this test only confirms the guard clause itself
      // is present in the query, not the DB's own matching behavior.
      const { processor, load } = buildWorker({ lat: 1, lng: 2, source: 'census-gazetteer' });

      await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

      const call = load.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({
        id: 'load-1',
        currentLocationUpdatedAt: new Date(JOB_DATA.asOfLoadUpdatedAt),
      });
    });

    it("CheckCall/Load writes run inside withTenantTransaction, scoped to the job's own organizationId", async () => {
      const { processor, prisma } = buildWorker({ lat: 1, lng: 2, source: 'census-gazetteer' });

      await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

      expect(prisma.withTenantTransaction).toHaveBeenCalledWith(ORG_ID, expect.any(Function));
    });
  });

  describe('STOP entity', () => {
    const JOB_DATA = {
      entityType: 'STOP' as const,
      entityId: 'stop-1',
      organizationId: ORG_ID,
      city: 'Philadelphia',
      state: 'PA',
    };

    it('a dataset HIT writes resolved coordinates directly to the Stop — no Load-level write at all', async () => {
      const { processor, stop, load } = buildWorker({
        lat: 39.95,
        lng: -75.16,
        source: 'census-gazetteer',
      });

      await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

      expect(stop.update).toHaveBeenCalledWith({
        where: { id: 'stop-1' },
        data: expect.objectContaining({
          resolvedLat: 39.95,
          resolvedLng: -75.16,
          resolutionStatus: 'RESOLVED_DATASET',
          resolutionSource: 'census-gazetteer',
        }),
      });
      expect(load.updateMany).not.toHaveBeenCalled();
    });

    it('a dataset MISS marks the Stop UNRESOLVED, never a guessed coordinate', async () => {
      const { processor, stop } = buildWorker(null);

      await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

      expect(stop.update).toHaveBeenCalledWith({
        where: { id: 'stop-1' },
        data: expect.objectContaining({ resolutionStatus: 'UNRESOLVED' }),
      });
    });
  });

  describe('worker heartbeat wiring', () => {
    it('registers itself with WorkerHeartbeatService on init', () => {
      const { heartbeat } = buildWorker(null);
      expect(heartbeat.register).toHaveBeenCalledWith(
        'resolve-location-worker',
        expect.any(Function),
      );
    });

    it('unregisters on shutdown', async () => {
      const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
      const heartbeat = {
        register: jest.fn(),
        unregister: jest.fn(),
        recordActivity: jest.fn(),
        recordError: jest.fn(),
      };
      const worker = new LocationResolutionWorker(
        redis as never,
        { withTenantTransaction: jest.fn() } as never,
        { resolve: jest.fn() } as never,
        heartbeat as never,
      );
      worker.onModuleInit();

      await worker.onModuleDestroy();

      expect(heartbeat.unregister).toHaveBeenCalledWith('resolve-location-worker');
    });
  });
});
