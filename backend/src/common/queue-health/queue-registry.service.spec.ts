import { QueueRegistryService } from './queue-registry.service';
import { MALWARE_SCAN_JOB_OPTIONS } from '../../modules/document/services/malware-scan.constants';
import { EMAIL_JOB_OPTIONS } from '../email/email-queue.constants';
import { RATE_CONFIRMATION_EXTRACTION_JOB_OPTIONS } from '../../modules/rate-confirmation-extraction/rate-confirmation-extraction.constants';
import { RATE_CONFIRMATION_JOB_OPTIONS } from '../../modules/quote-load/services/rate-confirmation.constants';
import { INVOICE_JOB_OPTIONS } from '../../modules/billing/services/invoice.constants';
import { SETTLEMENT_JOB_OPTIONS } from '../../modules/carrier-pay/services/settlement.constants';
import { IMPORT_COMMIT_JOB_OPTIONS } from '../../modules/import/import.constants';
import { SCHEDULED_JOBS_RETENTION } from '../../modules/background-jobs/services/scheduled-jobs.worker';

function fakeQueue(counts: Partial<Record<'waiting' | 'active' | 'delayed' | 'failed' | 'completed', number>>) {
  return {
    getJobCounts: jest.fn().mockResolvedValue(counts),
  };
}

describe('QueueRegistryService', () => {
  let service: QueueRegistryService;

  beforeEach(() => {
    service = new QueueRegistryService();
  });

  it('registering a queue makes it retrievable via getAllQueueCounts', async () => {
    const queue = fakeQueue({ waiting: 1, active: 2, delayed: 3, failed: 4, completed: 5 });
    service.register('malware-scan', queue as never);

    const result = await service.getAllQueueCounts();

    expect(result).toEqual([
      { name: 'malware-scan', waiting: 1, active: 2, delayed: 3, failed: 4, completed: 5 },
    ]);
  });

  it('returns counts for every registered queue', async () => {
    service.register('email-send', fakeQueue({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never);
    service.register('malware-scan', fakeQueue({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never);
    service.register('scheduled-jobs', fakeQueue({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }) as never);

    const result = await service.getAllQueueCounts();

    expect(result).toHaveLength(3);
  });

  it('reports the exact 8 real queue names when all 8 are registered', async () => {
    const names = [
      'malware-scan',
      'email-send',
      'rate-confirmation-extraction',
      'rate-confirmation-pdf',
      'invoice-pdf',
      'settlement-pdf',
      'import-commit',
      'scheduled-jobs',
    ];
    for (const name of names) {
      service.register(name, fakeQueue({}) as never);
    }

    const result = await service.getAllQueueCounts();

    expect(result.map((r) => r.name).sort()).toEqual([...names].sort());
  });

  it('calls getJobCounts with exactly the 5 requested count types, per queue', async () => {
    const queue = fakeQueue({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 });
    service.register('email-send', queue as never);

    await service.getAllQueueCounts();

    expect(queue.getJobCounts).toHaveBeenCalledWith('waiting', 'active', 'delayed', 'failed', 'completed');
  });

  it('defaults a missing count field to 0 rather than undefined', async () => {
    service.register('email-send', fakeQueue({ waiting: 2 }) as never);

    const [result] = await service.getAllQueueCounts();

    expect(result).toEqual({ name: 'email-send', waiting: 2, active: 0, delayed: 0, failed: 0, completed: 0 });
  });

  it('a Redis/getJobCounts failure on one queue rejects the whole call (surfaced to the controller for its 503 handling)', async () => {
    const failingQueue = { getJobCounts: jest.fn().mockRejectedValue(new Error('Redis unreachable')) };
    service.register('email-send', failingQueue as never);

    await expect(service.getAllQueueCounts()).rejects.toThrow('Redis unreachable');
  });

  it('getAllQueueCounts returns results sorted by name', async () => {
    service.register('settlement-pdf', fakeQueue({}) as never);
    service.register('email-send', fakeQueue({}) as never);

    const result = await service.getAllQueueCounts();

    expect(result.map((r) => r.name)).toEqual(['email-send', 'settlement-pdf']);
  });

  it('returns an empty array when nothing is registered', async () => {
    const result = await service.getAllQueueCounts();

    expect(result).toEqual([]);
  });

  it('security/PII — a snapshot never contains anything beyond name and the 5 count fields', async () => {
    service.register('email-send', fakeQueue({ waiting: 1, active: 1, delayed: 1, failed: 1, completed: 1 }) as never);

    const [result] = await service.getAllQueueCounts();

    expect(Object.keys(result).sort()).toEqual(['active', 'completed', 'delayed', 'failed', 'name', 'waiting']);
  });
});

describe('Monitoring Phase 4A-6 — retention configuration', () => {
  const EVENT_DRIVEN_RETENTION = {
    removeOnComplete: { count: 1000, age: 604800 },
    removeOnFail: { count: 2000, age: 2592000 },
  };

  it.each([
    ['MALWARE_SCAN_JOB_OPTIONS', MALWARE_SCAN_JOB_OPTIONS],
    ['EMAIL_JOB_OPTIONS', EMAIL_JOB_OPTIONS],
    ['RATE_CONFIRMATION_EXTRACTION_JOB_OPTIONS', RATE_CONFIRMATION_EXTRACTION_JOB_OPTIONS],
    ['RATE_CONFIRMATION_JOB_OPTIONS', RATE_CONFIRMATION_JOB_OPTIONS],
    ['INVOICE_JOB_OPTIONS', INVOICE_JOB_OPTIONS],
    ['SETTLEMENT_JOB_OPTIONS', SETTLEMENT_JOB_OPTIONS],
    ['IMPORT_COMMIT_JOB_OPTIONS', IMPORT_COMMIT_JOB_OPTIONS],
  ])('%s has the approved 7-day/1000 completed and 30-day/2000 failed retention', (_label, options) => {
    expect(options.removeOnComplete).toEqual(EVENT_DRIVEN_RETENTION.removeOnComplete);
    expect(options.removeOnFail).toEqual(EVENT_DRIVEN_RETENTION.removeOnFail);
  });

  it('the 7 event-driven queues keep their existing attempts/backoff retry policy unchanged', () => {
    for (const options of [
      MALWARE_SCAN_JOB_OPTIONS,
      EMAIL_JOB_OPTIONS,
      RATE_CONFIRMATION_EXTRACTION_JOB_OPTIONS,
      RATE_CONFIRMATION_JOB_OPTIONS,
      INVOICE_JOB_OPTIONS,
      SETTLEMENT_JOB_OPTIONS,
      IMPORT_COMMIT_JOB_OPTIONS,
    ]) {
      expect(options.attempts).toBe(3);
      expect(options.backoff).toEqual({ type: 'exponential', delay: 2000 });
    }
  });

  it('scheduled-jobs gets the approved 1-day/200 completed and 7-day/500 failed retention', () => {
    expect(SCHEDULED_JOBS_RETENTION.removeOnComplete).toEqual({ count: 200, age: 86400 });
    expect(SCHEDULED_JOBS_RETENTION.removeOnFail).toEqual({ count: 500, age: 604800 });
  });

  it('scheduled-jobs retention is distinct from (more restrictive than) the 7 event-driven queues', () => {
    expect(SCHEDULED_JOBS_RETENTION.removeOnComplete).not.toEqual(EVENT_DRIVEN_RETENTION.removeOnComplete);
    expect(SCHEDULED_JOBS_RETENTION.removeOnFail).not.toEqual(EVENT_DRIVEN_RETENTION.removeOnFail);
  });
});
