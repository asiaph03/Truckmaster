import { ImportCommitWorker } from './import-commit.worker';
import { ConflictError } from '../../../common/errors/app-error';

type Processor = (job: {
  data: unknown;
  attemptsMade: number;
  opts: { attempts?: number };
}) => Promise<void>;

let capturedProcessor: Processor | undefined;

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name: string, processor: Processor) => {
    capturedProcessor = processor;
    return { on: jest.fn(), close: jest.fn() };
  }),
}));

describe('ImportCommitWorker', () => {
  const JOB_DATA = { importBatchId: 'batch-1', organizationId: 'org-1' };
  const BATCH = { id: 'batch-1', entityType: 'CUSTOMER', createdByUserId: 'user-1' };

  function row(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'row-1',
      rowNumber: 1,
      status: 'VALID',
      mappedData: { legalName: 'Acme Inc' },
      duplicateWarning: null,
      acknowledgeDuplicate: false,
      ...overrides,
    };
  }

  function buildWorker(opts: {
    rows: ReturnType<typeof row>[];
    commitImpl?: jest.Mock;
    parentField?: { key: string; label: string; required: boolean };
    parentEntity?: 'CUSTOMER' | 'CARRIER';
    resolveParentImpl?: jest.Mock;
  }) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ quit: jest.fn() }) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };

    const tx = {
      importBatch: {
        findFirst: jest.fn().mockResolvedValue(BATCH),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      importBatchRow: {
        findMany: jest.fn().mockResolvedValue(opts.rows),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };

    const adapter = {
      entityType: 'CUSTOMER',
      parentField: opts.parentField,
      parentEntity: opts.parentEntity,
      commit: opts.commitImpl ?? jest.fn().mockResolvedValue({ entityId: 'created-1' }),
    };
    const adapters = { get: jest.fn().mockReturnValue(adapter) };
    const parentResolution = {
      resolveByLegalName: opts.resolveParentImpl ?? jest.fn().mockResolvedValue({ id: 'parent-1' }),
    };

    const worker = new ImportCommitWorker(
      redis as never,
      prisma as never,
      audit as never,
      adapters as never,
      parentResolution as never,
    );
    worker.onModuleInit();
    if (!capturedProcessor) throw new Error('Worker processor was not captured');
    const processor: Processor = capturedProcessor;
    return { processor, tx, audit, adapter, parentResolution };
  }

  it('commits every eligible VALID row and marks it IMPORTED', async () => {
    const { processor, tx, adapter } = buildWorker({
      rows: [row({ id: 'row-1', rowNumber: 1 }), row({ id: 'row-2', rowNumber: 2 })],
    });

    await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(adapter.commit).toHaveBeenCalledTimes(2);
    expect(tx.importBatchRow.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({ status: 'IMPORTED', createdEntityId: 'created-1' }),
    });
    expect(tx.importBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: expect.objectContaining({ status: 'COMPLETE' }),
    });
  });

  it('skips a row with an unacknowledged duplicate warning without calling commit', async () => {
    const { processor, tx, adapter } = buildWorker({
      rows: [row({ duplicateWarning: [{ customerId: 'c1' }], acknowledgeDuplicate: false })],
    });

    await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(adapter.commit).not.toHaveBeenCalled();
    expect(tx.importBatchRow.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({ status: 'SKIPPED' }),
    });
  });

  it('commits a row with an acknowledged duplicate warning', async () => {
    const { processor, adapter } = buildWorker({
      rows: [row({ duplicateWarning: [{ customerId: 'c1' }], acknowledgeDuplicate: true })],
    });

    await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(adapter.commit).toHaveBeenCalledTimes(1);
  });

  it('marks a row FAILED on a business-rule error and still processes the remaining rows (partial failure)', async () => {
    const commitImpl = jest
      .fn()
      .mockRejectedValueOnce(
        new ConflictError('A carrier with this MC number or DOT number already exists.'),
      )
      .mockResolvedValueOnce({ entityId: 'created-2' });
    const { processor, tx } = buildWorker({
      rows: [row({ id: 'row-1', rowNumber: 1 }), row({ id: 'row-2', rowNumber: 2 })],
      commitImpl,
    });

    await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(tx.importBatchRow.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        errors: ['A carrier with this MC number or DOT number already exists.'],
      }),
    });
    expect(tx.importBatchRow.update).toHaveBeenCalledWith({
      where: { id: 'row-2' },
      data: expect.objectContaining({ status: 'IMPORTED' }),
    });
  });

  it('marks a row FAILED (generic message) on an unexpected non-AppError, without crashing the job', async () => {
    const commitImpl = jest.fn().mockRejectedValue(new Error('unexpected db blip'));
    const { processor, tx } = buildWorker({ rows: [row()], commitImpl });

    await expect(
      processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } }),
    ).resolves.toBeUndefined();

    expect(tx.importBatchRow.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        errors: ['Unexpected error during import.'],
      }),
    });
  });

  it('resolves the parent for a child entity and passes its id to commit', async () => {
    const commitImpl = jest.fn().mockResolvedValue({ entityId: 'created-1' });
    const resolveParentImpl = jest.fn().mockResolvedValue({ id: 'carrier-9' });
    const { processor, adapter } = buildWorker({
      rows: [row({ mappedData: { firstName: 'Jane', __parentLegalName: 'Acme Carrier' } })],
      commitImpl,
      parentField: { key: 'carrierLegalName', label: 'Carrier Legal Name', required: true },
      parentEntity: 'CARRIER',
      resolveParentImpl,
    });

    await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(resolveParentImpl).toHaveBeenCalledWith('org-1', 'CARRIER', 'Acme Carrier');
    expect(adapter.commit).toHaveBeenCalledWith(
      'org-1',
      { firstName: 'Jane' },
      'user-1',
      'carrier-9',
      false,
      expect.any(Object),
    );
  });

  it('marks the row FAILED, without calling commit, when parent resolution fails at commit time', async () => {
    const commitImpl = jest.fn();
    const resolveParentImpl = jest
      .fn()
      .mockResolvedValue({ error: 'No carrier found named "Ghost LLC".' });
    const { processor, tx, adapter } = buildWorker({
      rows: [row({ mappedData: { firstName: 'Jane', __parentLegalName: 'Ghost LLC' } })],
      commitImpl,
      parentField: { key: 'carrierLegalName', label: 'Carrier Legal Name', required: true },
      parentEntity: 'CARRIER',
      resolveParentImpl,
    });

    await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(adapter.commit).not.toHaveBeenCalled();
    expect(tx.importBatchRow.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        errors: ['No carrier found named "Ghost LLC".'],
      }),
    });
  });

  it('only marks the batch FAILED on the final attempt when processJob throws (transient/job-level failure)', async () => {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ quit: jest.fn() }) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const tx = { importBatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => {
          if (fn.toString().includes('updateMany')) return fn(tx);
          throw new Error('connection lost');
        }),
    };
    const adapters = { get: jest.fn() };
    const parentResolution = { resolveByLegalName: jest.fn() };

    const worker = new ImportCommitWorker(
      redis as never,
      prisma as never,
      audit as never,
      adapters as never,
      parentResolution as never,
    );
    worker.onModuleInit();
    const processor = capturedProcessor!;

    // Not the final attempt — rethrows for BullMQ to retry, batch untouched.
    await expect(
      processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } }),
    ).rejects.toThrow('connection lost');
    expect(tx.importBatch.updateMany).not.toHaveBeenCalled();

    // Final attempt — records the batch as FAILED instead of rethrowing.
    await processor({ data: JOB_DATA, attemptsMade: 2, opts: { attempts: 3 } });
    expect(tx.importBatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'batch-1', organizationId: 'org-1' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
  });
});
