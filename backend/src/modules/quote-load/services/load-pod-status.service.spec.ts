import { LoadPodStatusService } from './load-pod-status.service';

const ORG_ID = 'org-1';
const LOAD_ID = 'load-1';

function buildService(opts: {
  currentPodStatus?: string;
  deliveryStopIds?: string[];
  cleanPodDocuments?: { entityId: string }[];
}) {
  const deliveryStopIds = opts.deliveryStopIds ?? ['stop-1', 'stop-2'];
  const tx = {
    load: {
      findFirstOrThrow: jest
        .fn()
        .mockResolvedValue({ id: LOAD_ID, podStatus: opts.currentPodStatus ?? 'NOT_RECEIVED' }),
      update: jest.fn().mockImplementation(({ data }) => ({ id: LOAD_ID, ...data })),
    },
    stop: {
      findMany: jest.fn().mockResolvedValue(deliveryStopIds.map((id) => ({ id }))),
    },
    document: {
      findMany: jest.fn().mockResolvedValue(opts.cleanPodDocuments ?? []),
    },
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new LoadPodStatusService(audit as never);

  return { service, tx, audit };
}

describe('LoadPodStatusService.recalculatePodStatus — Workflow 7 §7.2 / TECHNICAL_ARCHITECTURE §6.4', () => {
  it('returns NOT_RECEIVED when no delivery stop has a qualifying CLEAN POD', async () => {
    const { service, tx } = buildService({ cleanPodDocuments: [] });

    const result = await service.recalculatePodStatus(tx as never, ORG_ID, LOAD_ID);

    expect(result).toBe('NOT_RECEIVED');
  });

  it('returns PARTIAL when some but not all delivery stops have a CLEAN POD', async () => {
    const { service, tx } = buildService({ cleanPodDocuments: [{ entityId: 'stop-1' }] });

    const result = await service.recalculatePodStatus(tx as never, ORG_ID, LOAD_ID);

    expect(result).toBe('PARTIAL');
  });

  it('returns COMPLETE when every delivery stop has a CLEAN POD', async () => {
    const { service, tx } = buildService({
      cleanPodDocuments: [{ entityId: 'stop-1' }, { entityId: 'stop-2' }],
    });

    const result = await service.recalculatePodStatus(tx as never, ORG_ID, LOAD_ID);

    expect(result).toBe('COMPLETE');
  });

  it('persists and audits only when the derived value actually changes', async () => {
    const { service, tx, audit } = buildService({
      currentPodStatus: 'NOT_RECEIVED',
      cleanPodDocuments: [{ entityId: 'stop-1' }],
    });

    await service.recalculatePodStatus(tx as never, ORG_ID, LOAD_ID);

    expect(tx.load.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { podStatus: 'PARTIAL' } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'POD Milestone Updated' }),
    );
  });

  it('is a no-op (no persist, no audit) when the derived value is unchanged', async () => {
    const { service, tx, audit } = buildService({
      currentPodStatus: 'COMPLETE',
      cleanPodDocuments: [{ entityId: 'stop-1' }, { entityId: 'stop-2' }],
    });

    const result = await service.recalculatePodStatus(tx as never, ORG_ID, LOAD_ID);

    expect(result).toBe('COMPLETE');
    expect(tx.load.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('only queries CLEAN, current-version, POD-type documents against DELIVERY stops', async () => {
    const { service, tx } = buildService({});

    await service.recalculatePodStatus(tx as never, ORG_ID, LOAD_ID);

    expect(tx.stop.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ stopType: 'DELIVERY' }) }),
    );
    expect(tx.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: 'STOP',
          isCurrentVersion: true,
          scanStatus: 'CLEAN',
          documentType: { code: 'POD' },
        }),
      }),
    );
  });
});
