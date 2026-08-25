import { ActivityHistoryService } from './activity-history.service';
import { NotFoundError } from '../../../common/errors/app-error';

const ORG_ID = 'org-1';
const LOAD_ID = 'load-1';
const USER_ID = 'user-1';
const OWNER_ID = 'user-owner';

function buildService(opts: {
  load?: Record<string, unknown> | null;
  auditEntries?: Record<string, unknown>[];
  communications?: Record<string, unknown>[];
  notes?: Record<string, unknown>[];
}) {
  const defaultLoad = { id: LOAD_ID, createdByUserId: OWNER_ID };

  const tx = {
    load: {
      findFirst: jest.fn().mockResolvedValue('load' in opts ? opts.load : defaultLoad),
    },
    auditLog: {
      findMany: jest.fn().mockResolvedValue(opts.auditEntries ?? []),
      create: jest.fn(),
    },
    communicationActivity: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'comm-1', ...data })),
      findMany: jest.fn().mockResolvedValue(opts.communications ?? []),
    },
    internalNote: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'note-1', ...data })),
      findMany: jest.fn().mockResolvedValue(opts.notes ?? []),
    },
    domainEvent: {
      create: jest.fn(),
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const service = new ActivityHistoryService(prisma as never);

  return { service, tx };
}

describe('ActivityHistoryService — Frontend Phase 7 (Activity History)', () => {
  describe('addInternalNote', () => {
    it('creates an InternalNote with the acting user as author and no audit write', async () => {
      const { service, tx } = buildService({});

      const result = await service.addInternalNote(
        ORG_ID,
        LOAD_ID,
        { content: 'Called shipper.' },
        USER_ID,
      );

      expect(tx.internalNote.create).toHaveBeenCalledWith({
        data: {
          organizationId: ORG_ID,
          loadId: LOAD_ID,
          authorUserId: USER_ID,
          content: 'Called shipper.',
        },
      });
      expect(result).toMatchObject({ content: 'Called shipper.', authorUserId: USER_ID });
      // Regression guard: creating a Note must never also write an AuditLog
      // entry — the merged timeline sources NOTE-type entries from
      // internal_note only, and a parallel audit write would duplicate it
      // under a second, differently-styled entry type.
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the Load does not exist in this tenant', async () => {
      const { service } = buildService({ load: null });
      await expect(
        service.addInternalNote(ORG_ID, LOAD_ID, { content: 'x' }, USER_ID),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('logCommunicationActivity', () => {
    it('creates a CommunicationActivity with the acting user as logger and no audit write', async () => {
      const { service, tx } = buildService({});
      const dto = { activityType: 'Called Carrier', notes: 'Confirmed pickup time.' };

      const result = await service.logCommunicationActivity(ORG_ID, LOAD_ID, dto, USER_ID);

      expect(tx.communicationActivity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: ORG_ID,
            loadId: LOAD_ID,
            loggedByUserId: USER_ID,
            activityType: 'Called Carrier',
            notes: 'Confirmed pickup time.',
          }),
        }),
      );
      expect(result).toMatchObject({ activityType: 'Called Carrier' });
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('defaults occurredAt to now when omitted, and respects an explicit value when provided', async () => {
      const { service, tx } = buildService({});
      const before = Date.now();

      await service.logCommunicationActivity(
        ORG_ID,
        LOAD_ID,
        { activityType: 'Email', notes: 'x' },
        USER_ID,
      );
      const defaultedCall = tx.communicationActivity.create.mock.calls[0][0];
      const defaultedOccurredAt = (defaultedCall.data.occurredAt as Date).getTime();
      expect(defaultedOccurredAt).toBeGreaterThanOrEqual(before);
      expect(defaultedOccurredAt).toBeLessThanOrEqual(Date.now());

      await service.logCommunicationActivity(
        ORG_ID,
        LOAD_ID,
        { activityType: 'Email', notes: 'x', occurredAt: '2026-01-01T00:00:00.000Z' },
        USER_ID,
      );
      const explicitCall = tx.communicationActivity.create.mock.calls[1][0];
      expect((explicitCall.data.occurredAt as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('throws NotFoundError when the Load does not exist in this tenant', async () => {
      const { service } = buildService({ load: null });
      await expect(
        service.logCommunicationActivity(
          ORG_ID,
          LOAD_ID,
          { activityType: 'x', notes: 'x' },
          USER_ID,
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('getActivityHistory', () => {
    it('merges all three sources into one reverse-chronological timeline', async () => {
      const { service } = buildService({
        auditEntries: [
          {
            id: 'a1',
            action: 'Load Dispatched',
            previousValue: null,
            newValue: {},
            createdAt: new Date('2026-01-02T00:00:00Z'),
          },
        ],
        communications: [
          {
            id: 'c1',
            activityType: 'Called Carrier',
            notes: 'x',
            occurredAt: new Date('2026-01-03T00:00:00Z'),
          },
        ],
        notes: [{ id: 'n1', content: 'x', createdAt: new Date('2026-01-01T00:00:00Z') }],
      });

      const timeline = await service.getActivityHistory(ORG_ID, LOAD_ID, USER_ID, ['ADMIN']);

      expect(timeline.map((e) => e.type)).toEqual(['COMMUNICATION', 'AUDIT', 'NOTE']);
      expect(timeline.map((e) => e.id)).toEqual(['c1', 'a1', 'n1']);
    });

    it('redacts each audit entry using the Load owner (createdByUserId), not the acting user', async () => {
      const { service } = buildService({
        load: { id: LOAD_ID, createdByUserId: OWNER_ID },
        auditEntries: [
          {
            id: 'a1',
            action: 'Carrier Assigned',
            previousValue: null,
            newValue: { carrierRate: '1500.00' },
            createdAt: new Date(),
          },
        ],
      });

      const timeline = await service.getActivityHistory(ORG_ID, LOAD_ID, USER_ID, ['DISPATCHER']);
      const auditEntry = timeline.find((e) => e.type === 'AUDIT');
      expect((auditEntry?.newValue as Record<string, unknown>).carrierRate).toBeNull();
    });

    it('throws NotFoundError when the Load does not exist in this tenant', async () => {
      const { service } = buildService({ load: null });
      await expect(service.getActivityHistory(ORG_ID, LOAD_ID, USER_ID, ['ADMIN'])).rejects.toThrow(
        NotFoundError,
      );
    });
  });
});
