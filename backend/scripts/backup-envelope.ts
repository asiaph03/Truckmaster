/**
 * Task #10C.2 — the self-contained "TMSK" envelope format for encrypted
 * PostgreSQL backups (design approved in Task #10C.2A). Pure crypto
 * only: no AWS SDK import, no network call, no filesystem access — this
 * makes the whole format fully unit-testable in isolation (see
 * backup-envelope.spec.ts), with no mocking required.
 *
 * Binary layout:
 *   [4 bytes]   magic         = ASCII "TMSK"
 *   [1 byte]    formatVersion = 0x01
 *   [4 bytes]   headerLength  = big-endian uint32
 *   [N bytes]   header        = UTF-8 JSON (see EnvelopeHeader)
 *   [remaining] ciphertext    = AES-256-GCM ciphertext, to EOF
 *
 * The auth tag lives in the JSON header rather than being appended to
 * the ciphertext, so the ciphertext boundary is always exactly
 * `buffer.length - headerEnd` with no ambiguity. The plaintext data key
 * itself is never part of this format — only its KMS-encrypted form
 * (`encryptedDataKey`) is ever persisted, and only the caller (see
 * backup-database.ts) ever holds the plaintext key, in memory, briefly.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ENVELOPE_MAGIC = 'TMSK';
export const FORMAT_VERSION = 1;

const MAGIC_BYTES = Buffer.from(ENVELOPE_MAGIC, 'ascii');
const IV_LENGTH = 12; // 96 bits — NIST SP 800-38D recommended size for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits — GCM's standard/maximum tag size
const DATA_KEY_LENGTH = 32; // AES-256
const HEADER_LENGTH_FIELD_SIZE = 4;

export interface EnvelopeHeader {
  formatVersion: number;
  algorithm: 'AES-256-GCM';
  kmsKeyId: string;
  encryptedDataKey: string; // base64 — the KMS CiphertextBlob
  iv: string; // base64, 12 bytes
  authTag: string; // base64, 16 bytes
  sourceDatabase: string;
  createdAtUtc: string;
}

const REQUIRED_HEADER_FIELDS: (keyof EnvelopeHeader)[] = [
  'formatVersion',
  'algorithm',
  'kmsKeyId',
  'encryptedDataKey',
  'iv',
  'authTag',
  'sourceDatabase',
  'createdAtUtc',
];

/**
 * Encrypts `plaintext` with a fresh random IV using the given 32-byte
 * data key, and serializes the result into the TMSK envelope format
 * alongside the (already KMS-encrypted) form of that same data key.
 * Never writes or logs the plaintext data key itself — it is only ever
 * used in-memory, for exactly as long as this function runs.
 */
export function encryptToEnvelope(params: {
  plaintext: Buffer;
  plaintextDataKey: Buffer;
  encryptedDataKey: Buffer;
  kmsKeyId: string;
  sourceDatabase: string;
}): Buffer {
  const { plaintext, plaintextDataKey, encryptedDataKey, kmsKeyId, sourceDatabase } = params;
  if (plaintextDataKey.length !== DATA_KEY_LENGTH) {
    throw new Error(
      `Refusing to encrypt: data key must be exactly ${DATA_KEY_LENGTH} bytes (AES-256), got ${plaintextDataKey.length}.`,
    );
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', plaintextDataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const header: EnvelopeHeader = {
    formatVersion: FORMAT_VERSION,
    algorithm: 'AES-256-GCM',
    kmsKeyId,
    encryptedDataKey: encryptedDataKey.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    sourceDatabase,
    createdAtUtc: new Date().toISOString(),
  };

  return serializeEnvelope(header, ciphertext);
}

/** Builds the TMSK binary layout from an already-populated header and ciphertext. */
export function serializeEnvelope(header: EnvelopeHeader, ciphertext: Buffer): Buffer {
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const headerLength = Buffer.alloc(HEADER_LENGTH_FIELD_SIZE);
  headerLength.writeUInt32BE(headerJson.length, 0);
  const versionByte = Buffer.from([header.formatVersion]);
  return Buffer.concat([MAGIC_BYTES, versionByte, headerLength, headerJson, ciphertext]);
}

/**
 * Parses and structurally validates a TMSK envelope, without performing
 * any decryption. Throws a specific, descriptive error for every
 * malformed input (bad magic, unsupported version, truncated/unparseable
 * header, missing required field) before any cryptographic operation is
 * ever attempted — a corrupt file is rejected fast, never fed to KMS or
 * the cipher.
 */
export function parseEnvelope(buffer: Buffer): { header: EnvelopeHeader; ciphertext: Buffer } {
  const MIN_LENGTH = MAGIC_BYTES.length + 1 + HEADER_LENGTH_FIELD_SIZE;
  if (buffer.length < MIN_LENGTH) {
    throw new Error('Malformed backup envelope: file is too short to contain a valid header.');
  }

  const magic = buffer.subarray(0, MAGIC_BYTES.length);
  if (!magic.equals(MAGIC_BYTES)) {
    throw new Error(`Malformed backup envelope: invalid magic bytes (expected "${ENVELOPE_MAGIC}").`);
  }

  let offset = MAGIC_BYTES.length;
  const formatVersion = buffer.readUInt8(offset);
  offset += 1;
  if (formatVersion !== FORMAT_VERSION) {
    throw new Error(
      `Malformed backup envelope: unsupported format version ${formatVersion} (expected ${FORMAT_VERSION}).`,
    );
  }

  const headerLength = buffer.readUInt32BE(offset);
  offset += HEADER_LENGTH_FIELD_SIZE;

  if (offset + headerLength > buffer.length) {
    throw new Error(
      'Malformed backup envelope: truncated header — declared header length exceeds file size.',
    );
  }
  const headerJson = buffer.subarray(offset, offset + headerLength).toString('utf8');
  offset += headerLength;

  let header: EnvelopeHeader;
  try {
    header = JSON.parse(headerJson);
  } catch {
    throw new Error('Malformed backup envelope: header is not valid JSON.');
  }

  const missing = REQUIRED_HEADER_FIELDS.filter(
    (field) => header[field] === undefined || header[field] === null,
  );
  if (missing.length > 0) {
    throw new Error(`Malformed backup envelope: header missing required field(s): ${missing.join(', ')}.`);
  }

  const ciphertext = buffer.subarray(offset);
  return { header, ciphertext };
}

/**
 * Decrypts a parsed envelope's ciphertext using the given plaintext data
 * key (already obtained from KMS by the caller — this function performs
 * no KMS call itself, keeping it a pure, offline-testable primitive).
 * Throws if the authentication tag does not verify: GCM's all-or-nothing
 * guarantee means a tampered/corrupt ciphertext can never produce
 * silently-wrong plaintext — decryption either fully succeeds or throws.
 */
export function decryptEnvelope(header: EnvelopeHeader, ciphertext: Buffer, plaintextDataKey: Buffer): Buffer {
  if (plaintextDataKey.length !== DATA_KEY_LENGTH) {
    throw new Error(
      `Refusing to decrypt: data key must be exactly ${DATA_KEY_LENGTH} bytes (AES-256), got ${plaintextDataKey.length}.`,
    );
  }

  const iv = Buffer.from(header.iv, 'base64');
  const authTag = Buffer.from(header.authTag, 'base64');
  if (iv.length !== IV_LENGTH) {
    throw new Error(`Malformed backup envelope: IV must be ${IV_LENGTH} bytes, got ${iv.length}.`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(`Malformed backup envelope: auth tag must be ${AUTH_TAG_LENGTH} bytes, got ${authTag.length}.`);
  }

  const decipher = createDecipheriv('aes-256-gcm', plaintextDataKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
