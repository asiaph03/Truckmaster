import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
}
