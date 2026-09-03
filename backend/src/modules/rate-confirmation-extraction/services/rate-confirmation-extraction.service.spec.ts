import { RateConfirmationExtractionService } from './rate-confirmation-extraction.service';
import { BusinessRuleError, NotFoundError } from '../../../common/errors/app-error';

const ORG_ID = 'org-1';
const EXTRACTION_ID = 'extraction-1';
const DOC_ID = 'doc-1';

/**
 * Focused on `retry()`'s scanStatus gate (isDocumentConsumable) — the
 * only behavior touched by the SCAN_FAILED-is-consumable policy. This
 * service otherwise has no prior unit test coverage; `initiate`/
 * `confirm`/`getStatus` are unchanged by this work and not exercised
 * here.
 */
describe('RateConfirmationExtractionService.retry — gated on isDocumentConsumable(scanStatus)', () => {
  function buildService(scanStatus: string) {
    const job = {
      documentId: DOC_ID,
      extractionStatus: 'FAILED',
      extractionError: null,
      data: null,
    };
    const document = {
      id: DOC_ID,
      organizationId: ORG_ID,
      scanStatus,
      fileStorageKey: `org_${ORG_ID}/documents/${DOC_ID}`,
    };

    const tx = { document: { findFirst: jest.fn().mockResolvedValue(document) } };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const documentService = {};
    const jobStore = {
      get: jest.fn().mockResolvedValue(job),
      resetForRetry: jest.fn().mockResolvedValue(undefined),
    };
    const extractionQueue = { add: jest.fn().mockResolvedValue(undefined) };

    const service = new RateConfirmationExtractionService(
      prisma as never,
      documentService as never,
      jobStore as never,
      extractionQueue as never,
    );

    return { service, extractionQueue, jobStore };
  }

  it('allows retry when scanStatus is CLEAN (existing behavior, unchanged)', async () => {
    const { service, extractionQueue } = buildService('CLEAN');

    const result = await service.retry(ORG_ID, EXTRACTION_ID);

    expect(result).toEqual({ extractionId: EXTRACTION_ID, extractionStatus: 'PENDING' });
    expect(extractionQueue.add).toHaveBeenCalledWith(
      'extract',
      expect.objectContaining({ extractionId: EXTRACTION_ID, documentId: DOC_ID }),
      expect.anything(),
    );
  });

  it('allows retry when scanStatus is SCAN_FAILED (approved policy: a failed scan attempt does not block retry, only INFECTED does)', async () => {
    const { service, extractionQueue } = buildService('SCAN_FAILED');

    const result = await service.retry(ORG_ID, EXTRACTION_ID);

    expect(result).toEqual({ extractionId: EXTRACTION_ID, extractionStatus: 'PENDING' });
    expect(extractionQueue.add).toHaveBeenCalledWith(
      'extract',
      expect.objectContaining({ extractionId: EXTRACTION_ID, documentId: DOC_ID }),
      expect.anything(),
    );
  });

  it('rejects retry when scanStatus is INFECTED (remains blocked)', async () => {
    const { service, extractionQueue } = buildService('INFECTED');

    await expect(service.retry(ORG_ID, EXTRACTION_ID)).rejects.toThrow(BusinessRuleError);
    expect(extractionQueue.add).not.toHaveBeenCalled();
  });

  it('rejects retry when scanStatus is still PENDING (remains blocked)', async () => {
    const { service, extractionQueue } = buildService('PENDING');

    await expect(service.retry(ORG_ID, EXTRACTION_ID)).rejects.toThrow(BusinessRuleError);
    expect(extractionQueue.add).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the extraction job itself does not exist', async () => {
    const { service, jobStore } = buildService('CLEAN');
    jobStore.get.mockResolvedValue(null);

    await expect(service.retry(ORG_ID, EXTRACTION_ID)).rejects.toThrow(NotFoundError);
  });
});
