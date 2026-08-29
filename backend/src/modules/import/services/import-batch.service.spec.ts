import { ImportBatchService } from './import-batch.service';
import { PermissionError, ValidationError } from '../../../common/errors/app-error';

describe('ImportBatchService', () => {
  function buildService(
    overrides: {
      txOverrides?: Record<string, unknown>;
      parseCsvImpl?: jest.Mock;
      adapterOverrides?: Record<string, unknown>;
    } = {},
  ) {
    const tx = {
      importBatch: {
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'batch-1', ...data })),
        update: jest.fn().mockImplementation(({ data }) => ({ id: 'batch-1', ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'batch-1', status: 'IMPORTING' }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'batch-1',
          organizationId: 'org-1',
          entityType: 'CUSTOMER',
          status: 'UPLOADED',
          storageKey: 'org_org-1/imports/batch-1',
          fileFormat: 'CSV',
        }),
      },
      importBatchRow: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({ id: 'row-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      ...(overrides.txOverrides ?? {}),
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = {
      buildImportKey: jest.fn().mockReturnValue('org_org-1/imports/batch-1'),
      getUploadUrl: jest.fn().mockResolvedValue('https://upload.example/signed'),
      getObject: jest.fn().mockResolvedValue(Buffer.from('Legal Name\nAcme Inc\n')),
    };
    const spreadsheet = {
      parseCsv:
        overrides.parseCsvImpl ??
        jest
          .fn()
          .mockReturnValue({ headers: ['Legal Name'], rows: [{ 'Legal Name': 'Acme Inc' }] }),
      parseXlsx: jest.fn(),
    };
    const adapter = {
      entityType: 'CUSTOMER',
      fields: [{ key: 'legalName', label: 'Legal Name', required: true }],
      parentField: undefined,
      mapRow: jest.fn().mockReturnValue({ dto: { legalName: 'Acme Inc' }, errors: [] }),
      checkBusinessRules: jest.fn().mockResolvedValue({ errors: [] }),
      ...(overrides.adapterOverrides ?? {}),
    };
    const adapters = { get: jest.fn().mockReturnValue(adapter) };
    const parentResolution = { resolveByLegalName: jest.fn() };
    const commitQueue = { add: jest.fn().mockResolvedValue(undefined) };

    const service = new ImportBatchService(
      prisma as never,
      audit as never,
      storage as never,
      spreadsheet as never,
      adapters as never,
      parentResolution as never,
      commitQueue as never,
    );
    return { service, tx, storage, spreadsheet, adapter, commitQueue, audit };
  }

  describe('authorization', () => {
    it('rejects creating a CUSTOMER batch for a role outside the Customer role set', () => {
      const { service } = buildService();
      return expect(
        service.create(
          'org-1',
          { entityType: 'CUSTOMER', fileName: 'f.csv', fileFormat: 'CSV' },
          'user-1',
          ['DISPATCHER'],
        ),
      ).rejects.toThrow(PermissionError);
    });

    it('rejects creating a CARRIER batch for a role outside the Carrier role set', () => {
      const { service } = buildService();
      return expect(
        service.create(
          'org-1',
          { entityType: 'CARRIER', fileName: 'f.csv', fileFormat: 'CSV' },
          'user-1',
          ['SALES_BOOKING'],
        ),
      ).rejects.toThrow(PermissionError);
    });

    it('allows a Dispatcher to create a CARRIER batch (Carrier role set includes Dispatcher)', async () => {
      const { service } = buildService();
      await expect(
        service.create(
          'org-1',
          { entityType: 'CARRIER', fileName: 'f.csv', fileFormat: 'CSV' },
          'user-1',
          ['DISPATCHER'],
        ),
      ).resolves.toEqual(expect.objectContaining({ uploadUrl: 'https://upload.example/signed' }));
    });
  });

  describe('create', () => {
    it('builds a storage key, requests an upload URL, and audits creation', async () => {
      const { service, storage, audit } = buildService();
      const result = await service.create(
        'org-1',
        { entityType: 'CUSTOMER', fileName: 'customers.csv', fileFormat: 'CSV' },
        'user-1',
        ['ADMIN'],
      );
      expect(storage.buildImportKey).toHaveBeenCalledWith('org-1', 'batch-1');
      expect(storage.getUploadUrl).toHaveBeenCalledWith('org_org-1/imports/batch-1', 'text/csv');
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'Import Batch Created' }),
      );
      expect(result.importBatch.storageKey).toBe('org_org-1/imports/batch-1');
    });
  });

  describe('submitMapping', () => {
    it('rejects when a required field is not mapped to any column', () => {
      const { service } = buildService({
        txOverrides: {
          importBatch: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'batch-1',
              organizationId: 'org-1',
              entityType: 'CUSTOMER',
              status: 'MAPPING',
            }),
          },
        },
      });
      return expect(
        service.submitMapping('org-1', 'batch-1', { columnMapping: { Name: null } }, ['ADMIN']),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects submitting mapping when the batch is not in MAPPING status', () => {
      const { service } = buildService({
        txOverrides: {
          importBatch: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'batch-1',
              organizationId: 'org-1',
              entityType: 'CUSTOMER',
              status: 'UPLOADED',
            }),
          },
        },
      });
      return expect(
        service.submitMapping(
          'org-1',
          'batch-1',
          { columnMapping: { 'Legal Name': 'legalName' } },
          ['ADMIN'],
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('validates each row via the adapter and persists VALID/INVALID counts', async () => {
      const findFirstImpl = jest
        .fn()
        .mockResolvedValueOnce({
          id: 'batch-1',
          organizationId: 'org-1',
          entityType: 'CUSTOMER',
          status: 'MAPPING',
          storageKey: 'k',
          fileFormat: 'CSV',
        })
        .mockResolvedValue({
          id: 'batch-1',
          organizationId: 'org-1',
          entityType: 'CUSTOMER',
          status: 'VALIDATED',
        });
      const { service, tx } = buildService({
        txOverrides: {
          importBatch: { findFirst: findFirstImpl, update: jest.fn().mockResolvedValue({}) },
        },
        parseCsvImpl: jest.fn().mockReturnValue({
          headers: ['Legal Name'],
          rows: [{ 'Legal Name': 'Acme Inc' }, { 'Legal Name': '' }],
        }),
        adapterOverrides: {
          mapRow: jest
            .fn()
            .mockReturnValueOnce({ dto: { legalName: 'Acme Inc' }, errors: [] })
            .mockReturnValueOnce({ errors: ['Legal Name is required.'] }),
        },
      });

      await service.submitMapping(
        'org-1',
        'batch-1',
        { columnMapping: { 'Legal Name': 'legalName' } },
        ['ADMIN'],
      );

      expect(tx.importBatchRow.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ rowNumber: 1, status: 'VALID' }),
          expect.objectContaining({ rowNumber: 2, status: 'INVALID' }),
        ]),
      });
      expect(tx.importBatch.update).toHaveBeenCalledWith({
        where: { id: 'batch-1' },
        data: expect.objectContaining({
          status: 'VALIDATED',
          validRowCount: 1,
          invalidRowCount: 1,
        }),
      });
    });
  });

  describe('updateRow', () => {
    it('resets a SKIPPED row (unacknowledged duplicate) back to VALID when acknowledged, so it is picked up by the next commit', async () => {
      const { service, tx } = buildService({
        txOverrides: {
          importBatch: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'batch-1',
              organizationId: 'org-1',
              entityType: 'CUSTOMER',
              status: 'COMPLETE',
            }),
          },
          importBatchRow: {
            findFirst: jest.fn().mockResolvedValue({ id: 'row-1', status: 'SKIPPED' }),
            update: jest.fn().mockResolvedValue({}),
          },
        },
      });

      await service.updateRow('org-1', 'batch-1', 'row-1', { acknowledgeDuplicate: true }, [
        'ADMIN',
      ]);

      expect(tx.importBatchRow.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: expect.objectContaining({ acknowledgeDuplicate: true, status: 'VALID' }),
      });
    });

    it('does not reset status when acknowledging a row that is still VALID (not yet processed)', async () => {
      const { service, tx } = buildService({
        txOverrides: {
          importBatch: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'batch-1',
              organizationId: 'org-1',
              entityType: 'CUSTOMER',
              status: 'VALIDATED',
            }),
          },
          importBatchRow: {
            findFirst: jest.fn().mockResolvedValue({ id: 'row-1', status: 'VALID' }),
            update: jest.fn().mockResolvedValue({}),
          },
        },
      });

      await service.updateRow('org-1', 'batch-1', 'row-1', { acknowledgeDuplicate: true }, [
        'ADMIN',
      ]);

      expect(tx.importBatchRow.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { acknowledgeDuplicate: true },
      });
    });
  });

  describe('commit', () => {
    it('rejects committing a batch that has not been validated', () => {
      const { service } = buildService({
        txOverrides: {
          importBatch: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'batch-1',
              organizationId: 'org-1',
              entityType: 'CUSTOMER',
              status: 'MAPPING',
            }),
          },
        },
      });
      return expect(service.commit('org-1', 'batch-1', 'user-1', ['ADMIN'])).rejects.toThrow(
        ValidationError,
      );
    });

    it('transitions to IMPORTING via an atomic conditional update, audits, and enqueues the commit job', async () => {
      const { service, tx, commitQueue, audit } = buildService({
        txOverrides: {
          importBatch: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'batch-1',
              organizationId: 'org-1',
              entityType: 'CUSTOMER',
              status: 'VALIDATED',
            }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'batch-1', status: 'IMPORTING' }),
          },
        },
      });

      await service.commit('org-1', 'batch-1', 'user-1', ['ADMIN']);

      expect(tx.importBatch.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'batch-1',
          organizationId: 'org-1',
          status: { in: ['VALIDATED', 'COMPLETE'] },
        },
        data: { status: 'IMPORTING' },
      });
      expect(commitQueue.add).toHaveBeenCalledWith(
        'commit',
        { importBatchId: 'batch-1', organizationId: 'org-1' },
        expect.any(Object),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'Import Batch Committed' }),
      );
    });

    it('rejects a concurrent commit race — the loser sees updateMany affect 0 rows and never enqueues a second job', async () => {
      const { service, commitQueue } = buildService({
        txOverrides: {
          importBatch: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'batch-1',
              organizationId: 'org-1',
              entityType: 'CUSTOMER',
              status: 'VALIDATED',
            }),
            // Simulates another concurrent request already having flipped
            // the status between this request's guard check and its own
            // conditional update.
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
        },
      });

      await expect(service.commit('org-1', 'batch-1', 'user-1', ['ADMIN'])).rejects.toThrow(
        ValidationError,
      );
      expect(commitQueue.add).not.toHaveBeenCalled();
    });

    it('allows re-committing a COMPLETE batch (to pick up newly-acknowledged duplicate rows)', async () => {
      const { service, commitQueue } = buildService({
        txOverrides: {
          importBatch: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'batch-1',
              organizationId: 'org-1',
              entityType: 'CUSTOMER',
              status: 'COMPLETE',
            }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'batch-1', status: 'IMPORTING' }),
          },
        },
      });

      await service.commit('org-1', 'batch-1', 'user-1', ['ADMIN']);
      expect(commitQueue.add).toHaveBeenCalled();
    });
  });
});
