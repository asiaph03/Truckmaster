/**
 * Task #10C.2/#10C.4 — thin wrappers around the AWS SDK calls the backup
 * and restore-verification pipelines need (KMS GenerateDataKey/Decrypt,
 * S3 PutObject/GetObject). Each function accepts an already-constructed
 * client rather than building one itself, so the orchestration in
 * backup-database.ts/backup-restore-verify.ts can be unit-tested by
 * passing a minimal `{ send: jest.fn() }` stub instead of a real
 * KMSClient/S3Client — no new mocking dependency needed, and no real
 * AWS credential is ever required to unit-test the pipeline logic.
 */
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

/** Structural subset of KMSClient/S3Client that the two functions below actually use. */
export interface MinimalAwsClient {
  send(command: unknown): Promise<unknown>;
}

export interface DataKeyResult {
  plaintextKey: Buffer;
  encryptedKey: Buffer;
}

export function createKmsClient(region: string, accessKeyId: string, secretAccessKey: string): KMSClient {
  return new KMSClient({ region, credentials: { accessKeyId, secretAccessKey } });
}

export function createS3Client(params: {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}): S3Client {
  return new S3Client({
    region: params.region,
    credentials: { accessKeyId: params.accessKeyId, secretAccessKey: params.secretAccessKey },
    ...(params.endpoint ? { endpoint: params.endpoint } : {}),
    ...(params.forcePathStyle !== undefined ? { forcePathStyle: params.forcePathStyle } : {}),
  });
}

/**
 * Requests a fresh AES-256 data key from KMS. Returns both the
 * plaintext key (the caller must use it in-memory only, then discard
 * it — see backup-database.ts) and its KMS-encrypted form (safe to
 * persist). Never logs either value itself.
 */
export async function generateDataKey(client: MinimalAwsClient, kmsKeyId: string): Promise<DataKeyResult> {
  const result = (await client.send(
    new GenerateDataKeyCommand({ KeyId: kmsKeyId, KeySpec: 'AES_256' }),
  )) as { Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array };

  if (!result.Plaintext || !result.CiphertextBlob) {
    throw new Error(
      'KMS GenerateDataKey returned an incomplete response (missing Plaintext or CiphertextBlob).',
    );
  }
  return {
    plaintextKey: Buffer.from(result.Plaintext),
    encryptedKey: Buffer.from(result.CiphertextBlob),
  };
}

/**
 * Uploads the encrypted backup envelope. Never overwrites an existing
 * key — the caller is responsible for generating a unique key per
 * backup (see buildS3ObjectKey in backup-database.ts), and
 * `IfNoneMatch: '*'` makes that a hard, server-enforced guarantee
 * rather than a probabilistic one based on timestamp uniqueness alone:
 * if an object already exists at this exact key, S3 rejects the PUT
 * with a 412 Precondition Failed instead of overwriting it, which the
 * AWS SDK surfaces as a rejected promise — caught by the caller
 * (encryptAndUploadDump) exactly like any other upload failure, with
 * the same "never delete the local encrypted file on a failed upload"
 * guarantee. Requests SSE-S3 (AES256) to match the existing bucket's
 * server-side encryption behavior; this is defense-in-depth alongside
 * the application-level AES-256-GCM encryption already applied to
 * `body`, not a replacement for it.
 */
export async function uploadObject(
  client: MinimalAwsClient,
  bucket: string,
  key: string,
  body: Buffer,
): Promise<void> {
  const result = (await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/octet-stream',
      ServerSideEncryption: 'AES256',
      IfNoneMatch: '*',
    }),
  )) as { $metadata?: { httpStatusCode?: number } };

  const statusCode = result.$metadata?.httpStatusCode;
  if (statusCode !== undefined && (statusCode < 200 || statusCode >= 300)) {
    throw new Error(`S3 upload did not succeed — unexpected HTTP status ${statusCode}.`);
  }
}

/** One S3 object's identity as returned by ListObjectsV2 — only the two fields the freshness checker needs. */
export interface S3ObjectSummary {
  key: string;
  lastModified: Date;
}

/**
 * Monitoring Phase 3 — lists every object under `prefix` in a single
 * request. Deliberately does not paginate beyond one ListObjectsV2 page
 * (max 1,000 keys): the only caller (backup-freshness-check.ts) queries
 * the "daily/" prefix, which grows by roughly one object per day, so
 * reaching the 1,000-key page limit is not a near-term concern and
 * adding pagination now would be complexity without a corresponding
 * present need. Entries missing a Key or LastModified (shouldn't happen
 * per the S3 API contract, but the SDK types them as optional) are
 * dropped rather than risking a crash on malformed data.
 */
export async function listObjects(
  client: MinimalAwsClient,
  bucket: string,
  prefix: string,
): Promise<S3ObjectSummary[]> {
  const result = (await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))) as {
    Contents?: { Key?: string; LastModified?: Date }[];
  };
  return (result.Contents ?? [])
    .filter((entry): entry is { Key: string; LastModified: Date } => !!entry.Key && !!entry.LastModified)
    .map((entry) => ({ key: entry.Key, lastModified: entry.LastModified }));
}

/**
 * Downloads exactly the object at `key` — never lists or scans the
 * bucket. Used by restore verification to fetch the one backup object
 * it was explicitly told to verify (see backup-restore-verify.ts).
 */
export async function downloadObject(client: MinimalAwsClient, bucket: string, key: string): Promise<Buffer> {
  const result = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))) as {
    Body?: { transformToByteArray(): Promise<Uint8Array> };
  };
  if (!result.Body) {
    throw new Error(`S3 GetObject for s3://${bucket}/${key} returned no body.`);
  }
  const bytes = await result.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * Unwraps a KMS-encrypted data key back to its plaintext form. Used
 * only by the restore-verification path, with the RESTORER identity's
 * credentials — never the uploader's (see backup-restore-verify.ts).
 * Never logs the returned plaintext key.
 */
export async function decryptDataKey(
  client: MinimalAwsClient,
  encryptedDataKey: Buffer,
  kmsKeyId: string,
): Promise<Buffer> {
  const result = (await client.send(
    new DecryptCommand({ CiphertextBlob: encryptedDataKey, KeyId: kmsKeyId }),
  )) as { Plaintext?: Uint8Array };
  if (!result.Plaintext) {
    throw new Error('KMS Decrypt returned an incomplete response (missing Plaintext).');
  }
  return Buffer.from(result.Plaintext);
}
