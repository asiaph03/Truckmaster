import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppConfig } from '../../config/configuration';

/**
 * Monitoring Phase 4A-13 — S3 operation observability. organizationId/jobId
 * are threaded in by callers that already have them (workers pass their
 * job's org+id; HTTP-path callers pass organizationId only) — never guessed,
 * never sourced from AsyncLocalStorage/global context.
 */
type S3CallContext = { organizationId?: string; jobId?: string };
type S3ErrorCategory = 'client_error' | 'server_error' | 'network_error' | 'unknown';

/**
 * Coarse operational category only — not a claim about the exact underlying
 * AWS failure. Deliberately never reads error.message/.stack/$metadata; only
 * the typed, purpose-built $fault field (SmithyException) is inspected.
 */
function categorizeS3Error(error: unknown): S3ErrorCategory {
  const fault = (error as { $fault?: unknown } | null)?.$fault;
  if (fault === 'client') return 'client_error';
  if (fault === 'server') return 'server_error';
  if (error instanceof Error) return 'network_error';
  return 'unknown';
}

/**
 * Thin wrapper around the S3-compatible object storage client
 * (TECHNICAL_ARCHITECTURE.md §8, Decision 9). No document domain logic
 * lives here (that's the Document module, Phase 2) — this service only
 * knows how to generate keys, presigned upload URLs, and presigned
 * download URLs.
 *
 * Org-scoped key convention (Decision 9 / §8.4): `org_{organizationId}/documents/{uuid}`.
 * Quarantined files (infected/scan-failed, Decision 10) use
 * `org_{organizationId}/quarantine/{uuid}` — a distinct prefix a bucket
 * policy can independently deny signed-URL generation against, as a
 * second enforcement layer beyond the application's own scan_status check.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService<AppConfig>) {
    const storageConfig = this.config.get('storage', { infer: true })!;
    this.bucket = storageConfig.bucket;
    this.client = new S3Client({
      endpoint: storageConfig.endpoint,
      region: storageConfig.region,
      forcePathStyle: storageConfig.forcePathStyle,
      credentials: {
        accessKeyId: storageConfig.accessKeyId,
        secretAccessKey: storageConfig.secretAccessKey,
      },
    });
  }

  buildDocumentKey(organizationId: string, documentId: string): string {
    return `org_${organizationId}/documents/${documentId}`;
  }

  buildQuarantineKey(organizationId: string, documentId: string): string {
    return `org_${organizationId}/quarantine/${documentId}`;
  }

  /**
   * Bulk Import (approved technical design, Decision 8/storage) — import
   * source files are never reviewable Documents (no versioning, no human
   * download, read once server-side via getObject()), so they get their
   * own key prefix rather than going through the Document module.
   */
  buildImportKey(organizationId: string, importBatchId: string): string {
    return `org_${organizationId}/imports/${importBatchId}`;
  }

  /**
   * Phase 4 addition — direct server-side upload, for content the
   * application itself generates (e.g. a Rate Confirmation PDF rendered by
   * the RateConfirmationWorker) rather than a client-provided file. Every
   * other write path in this class remains the presigned-URL flow
   * (Decision 9); this is additive, not a replacement for it.
   */
  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
    context?: S3CallContext,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
      );
      this.logS3Operation('putObject', context, Date.now() - startedAt, 'success');
    } catch (error) {
      this.logS3Operation(
        'putObject',
        context,
        Date.now() - startedAt,
        'failure',
        categorizeS3Error(error),
      );
      throw error;
    }
  }

  async getUploadUrl(key: string, contentType: string, expiresInSeconds = 300): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async getDownloadUrl(key: string, expiresInSeconds = 300): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  /**
   * Frontend Phase 16 addition — fetches an object's raw bytes directly
   * (never via a signed URL) for server-side processing that needs the
   * actual content. First caller: CloudmersiveMalwareScanner, which must
   * submit file bytes to the scan API — going through getDownloadUrl
   * would issue a public-ish signed URL before the scan/CLEAN check has
   * even run, contradicting §8.4's "no download before CLEAN" rule.
   */
  async getObject(key: string, context?: S3CallContext): Promise<Buffer> {
    const startedAt = Date.now();
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      const result = Buffer.concat(chunks);
      this.logS3Operation('getObject', context, Date.now() - startedAt, 'success');
      return result;
    } catch (error) {
      this.logS3Operation(
        'getObject',
        context,
        Date.now() - startedAt,
        'failure',
        categorizeS3Error(error),
      );
      throw error;
    }
  }

  /**
   * Moves an object from the documents prefix to the quarantine prefix
   * (Decision 10, §8.1 step 5) — S3 has no native move, so this is a
   * copy-then-delete. A bucket policy denying signed-URL generation
   * against the quarantine prefix is the second enforcement layer beyond
   * the application's own `scan_status` check (§8.1) — not configured
   * here (bucket policy is deployment-stage infrastructure, not
   * application code).
   */
  async moveToQuarantine(fromKey: string, toKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${fromKey}`,
        Key: toKey,
      }),
    );
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: fromKey }));
  }

  /**
   * Load-Level Documents Delete — permanently removes one object. Only
   * `moveToQuarantine` used `DeleteObjectCommand` before this (as half of
   * a copy-then-delete); this is the first standalone, caller-invoked
   * delete. Deleting a nonexistent key is not an error (S3 delete is
   * idempotent), which is intentionally convenient for the document
   * module's family-delete loop.
   */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * Monitoring Phase 4A-13 — S3 getObject/putObject timing/error
   * attribution, matching the exact 4A-11/4A-12 pattern (plain key=value
   * line, Logger.log on success / Logger.warn on failure). Never logs the
   * bucket, key, a signed URL, file contents, or any AWS error field
   * (message/stack/$metadata) — only operation, correlation ids, duration,
   * outcome, and a coarse errorCategory.
   */
  private logS3Operation(
    operation: 'getObject' | 'putObject',
    context: S3CallContext | undefined,
    durationMs: number,
    outcome: 'success' | 'failure',
    errorCategory?: S3ErrorCategory,
  ): void {
    const parts = ['event=s3_operation', 'dependency=s3', `operation=${operation}`];
    if (context?.organizationId) parts.push(`organizationId=${context.organizationId}`);
    if (context?.jobId) parts.push(`jobId=${context.jobId}`);
    parts.push(`durationMs=${durationMs}`, `outcome=${outcome}`);
    if (errorCategory !== undefined) parts.push(`errorCategory=${errorCategory}`);

    const message = parts.join(' ');
    if (outcome === 'success') {
      this.logger.log(message);
    } else {
      this.logger.warn(message);
    }
  }
}
