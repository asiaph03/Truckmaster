import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { ExtractedRateConfirmationData } from '../rate-confirmation-extractor.interface';
import {
  EXTRACTION_JOB_REDIS_TTL_SECONDS,
  extractionJobRedisKey,
} from '../rate-confirmation-extraction.constants';

export type ExtractionStatus = 'NOT_STARTED' | 'PENDING' | 'COMPLETE' | 'FAILED';

export interface ExtractionJobRecord {
  extractionId: string;
  documentId: string;
  organizationId: string;
  extractionStatus: ExtractionStatus;
  extractionError: string | null;
  data: ExtractedRateConfirmationData | null;
}

/**
 * Rate Confirmation → New Load auto-populate feature — the extraction
 * job's transient state lives entirely in Redis (approved design
 * decision: this is scratch state for one New Load form session, never
 * queried after the fact, discarded once the user submits or abandons
 * the page). Deliberately does NOT store `scanStatus` here — that's
 * already authoritatively tracked on the Document row by the existing
 * malware-scan pipeline (document.service.ts), and duplicating it here
 * would risk it going stale; RateConfirmationExtractionService reads
 * scanStatus live from Postgres and merges it with this record.
 *
 * TTL refreshed on every write so an actively-in-progress extraction
 * never expires mid-flight, then left to expire naturally once the user
 * finishes (submits the Load or navigates away) — no explicit cleanup
 * job needed.
 */
@Injectable()
export class RateConfirmationExtractionJobStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async create(organizationId: string, extractionId: string, documentId: string): Promise<void> {
    const record: ExtractionJobRecord = {
      extractionId,
      documentId,
      organizationId,
      extractionStatus: 'NOT_STARTED',
      extractionError: null,
      data: null,
    };
    await this.write(organizationId, extractionId, record);
  }

  async get(organizationId: string, extractionId: string): Promise<ExtractionJobRecord | null> {
    const raw = await this.redis.get(extractionJobRedisKey(organizationId, extractionId));
    if (!raw) return null;
    const record = JSON.parse(raw) as ExtractionJobRecord;
    // Defense-in-depth — the key is already organizationId-scoped, but
    // never trust a caller-supplied organizationId without this check.
    if (record.organizationId !== organizationId) return null;
    return record;
  }

  async markInProgress(organizationId: string, extractionId: string): Promise<void> {
    const existing = await this.get(organizationId, extractionId);
    if (!existing) return;
    await this.write(organizationId, extractionId, {
      ...existing,
      extractionStatus: 'PENDING',
      extractionError: null,
    });
  }

  async markComplete(
    organizationId: string,
    extractionId: string,
    data: ExtractedRateConfirmationData,
  ): Promise<void> {
    const existing = await this.get(organizationId, extractionId);
    if (!existing) return;
    await this.write(organizationId, extractionId, {
      ...existing,
      extractionStatus: 'COMPLETE',
      extractionError: null,
      data,
    });
  }

  async markFailed(organizationId: string, extractionId: string, error: string): Promise<void> {
    const existing = await this.get(organizationId, extractionId);
    if (!existing) return;
    await this.write(organizationId, extractionId, {
      ...existing,
      extractionStatus: 'FAILED',
      extractionError: error,
      data: null,
    });
  }

  /** Used by the retry endpoint — resets to a fresh pending state without needing a new upload. */
  async resetForRetry(organizationId: string, extractionId: string): Promise<void> {
    const existing = await this.get(organizationId, extractionId);
    if (!existing) return;
    await this.write(organizationId, extractionId, {
      ...existing,
      extractionStatus: 'PENDING',
      extractionError: null,
      data: null,
    });
  }

  private async write(
    organizationId: string,
    extractionId: string,
    record: ExtractionJobRecord,
  ): Promise<void> {
    await this.redis.set(
      extractionJobRedisKey(organizationId, extractionId),
      JSON.stringify(record),
      'EX',
      EXTRACTION_JOB_REDIS_TTL_SECONDS,
    );
  }
}
