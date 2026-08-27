import { Injectable } from '@nestjs/common';
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
   * Phase 4 addition — direct server-side upload, for content the
   * application itself generates (e.g. a Rate Confirmation PDF rendered by
   * the RateConfirmationWorker) rather than a client-provided file. Every
   * other write path in this class remains the presigned-URL flow
   * (Decision 9); this is additive, not a replacement for it.
   */
  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
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
  async getObject(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
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
}
