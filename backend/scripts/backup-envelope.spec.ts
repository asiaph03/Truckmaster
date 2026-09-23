import { randomBytes } from 'node:crypto';
import {
  decryptEnvelope,
  encryptToEnvelope,
  ENVELOPE_MAGIC,
  FORMAT_VERSION,
  parseEnvelope,
  serializeEnvelope,
  type EnvelopeHeader,
} from './backup-envelope';

/**
 * Task #10C.2 — pure, offline tests for the TMSK envelope format. No
 * AWS SDK, no network, no filesystem — every "data key" here is just a
 * random 32-byte buffer standing in for what KMS would return; the
 * pipeline that actually calls KMS is tested separately (with an
 * injected stub) in backup-database.spec.ts.
 */

function makeDataKey(): Buffer {
  return randomBytes(32);
}

describe('encryptToEnvelope / parseEnvelope / decryptEnvelope — round trip', () => {
  it('decrypts back to the exact original plaintext bytes', () => {
    const plaintext = Buffer.from('PGDMP-fake-custom-format-dump-bytes-1234567890', 'utf8');
    const plaintextDataKey = makeDataKey();
    const encryptedDataKey = Buffer.from('fake-kms-ciphertext-blob');

    const envelope = encryptToEnvelope({
      plaintext,
      plaintextDataKey,
      encryptedDataKey,
      kmsKeyId: 'arn:aws:kms:us-east-1:955075461399:key/2fa9912f-1f3b-4fbb-8db0-c1660b0b68db',
      sourceDatabase: 'tms_dev',
    });

    const { header, ciphertext } = parseEnvelope(envelope);
    const decrypted = decryptEnvelope(header, ciphertext, plaintextDataKey);

    expect(decrypted).toEqual(plaintext);
    expect(header.formatVersion).toBe(FORMAT_VERSION);
    expect(header.algorithm).toBe('AES-256-GCM');
    expect(header.sourceDatabase).toBe('tms_dev');
    expect(header.encryptedDataKey).toBe(encryptedDataKey.toString('base64'));
  });

  it('round-trips a large, binary-ish plaintext correctly', () => {
    const plaintext = randomBytes(256 * 1024); // 256 KB of arbitrary bytes
    const plaintextDataKey = makeDataKey();

    const envelope = encryptToEnvelope({
      plaintext,
      plaintextDataKey,
      encryptedDataKey: Buffer.from('blob'),
      kmsKeyId: 'test-key',
      sourceDatabase: 'tms_local_test',
    });

    const { header, ciphertext } = parseEnvelope(envelope);
    const decrypted = decryptEnvelope(header, ciphertext, plaintextDataKey);
    expect(decrypted).toEqual(plaintext);
  });

  it('produces a different IV (and ciphertext) on every call, even for identical input', () => {
    const plaintext = Buffer.from('identical input');
    const plaintextDataKey = makeDataKey();
    const params = { plaintext, plaintextDataKey, encryptedDataKey: Buffer.from('blob'), kmsKeyId: 'k', sourceDatabase: 'db' };

    const envelopeA = encryptToEnvelope(params);
    const envelopeB = encryptToEnvelope(params);

    const { header: headerA } = parseEnvelope(envelopeA);
    const { header: headerB } = parseEnvelope(envelopeB);
    expect(headerA.iv).not.toBe(headerB.iv);
    expect(envelopeA).not.toEqual(envelopeB);
  });

  it('rejects a data key that is not exactly 32 bytes when encrypting', () => {
    expect(() =>
      encryptToEnvelope({
        plaintext: Buffer.from('x'),
        plaintextDataKey: randomBytes(16),
        encryptedDataKey: Buffer.from('blob'),
        kmsKeyId: 'k',
        sourceDatabase: 'db',
      }),
    ).toThrow(/32 bytes/);
  });
});

describe('AES-GCM authentication — tampering is always detected', () => {
  function buildValidEnvelope() {
    const plaintextDataKey = makeDataKey();
    const envelope = encryptToEnvelope({
      plaintext: Buffer.from('sensitive financial data'),
      plaintextDataKey,
      encryptedDataKey: Buffer.from('blob'),
      kmsKeyId: 'k',
      sourceDatabase: 'db',
    });
    return { envelope, plaintextDataKey };
  }

  it('throws when a ciphertext byte is flipped after encryption', () => {
    const { envelope, plaintextDataKey } = buildValidEnvelope();
    const tampered = Buffer.from(envelope);
    tampered[tampered.length - 1] ^= 0xff; // flip the last ciphertext byte

    const { header, ciphertext } = parseEnvelope(tampered);
    expect(() => decryptEnvelope(header, ciphertext, plaintextDataKey)).toThrow();
  });

  it('throws when the stored authTag itself is tampered with', () => {
    const { envelope, plaintextDataKey } = buildValidEnvelope();
    const { header, ciphertext } = parseEnvelope(envelope);

    const tamperedTagBytes = Buffer.from(header.authTag, 'base64');
    tamperedTagBytes[0] ^= 0xff;
    const tamperedHeader: EnvelopeHeader = { ...header, authTag: tamperedTagBytes.toString('base64') };

    expect(() => decryptEnvelope(tamperedHeader, ciphertext, plaintextDataKey)).toThrow();
  });

  it('throws when decrypting with the wrong data key', () => {
    const { envelope } = buildValidEnvelope();
    const { header, ciphertext } = parseEnvelope(envelope);
    expect(() => decryptEnvelope(header, ciphertext, makeDataKey())).toThrow();
  });
});

describe('parseEnvelope — structural corruption is rejected before any decryption is attempted', () => {
  function buildValidEnvelope(): Buffer {
    return encryptToEnvelope({
      plaintext: Buffer.from('data'),
      plaintextDataKey: makeDataKey(),
      encryptedDataKey: Buffer.from('blob'),
      kmsKeyId: 'k',
      sourceDatabase: 'db',
    });
  }

  it('rejects invalid magic bytes', () => {
    const envelope = buildValidEnvelope();
    const corrupted = Buffer.from(envelope);
    corrupted.write('XXXX', 0, 'ascii');
    expect(() => parseEnvelope(corrupted)).toThrow(/magic/i);
  });

  it('rejects an unsupported format version', () => {
    const envelope = buildValidEnvelope();
    const corrupted = Buffer.from(envelope);
    corrupted.writeUInt8(99, ENVELOPE_MAGIC.length); // version byte
    expect(() => parseEnvelope(corrupted)).toThrow(/format version/i);
  });

  it('rejects a truncated header (declared length exceeds actual file size)', () => {
    const envelope = buildValidEnvelope();
    const headerLengthOffset = ENVELOPE_MAGIC.length + 1;
    const corrupted = Buffer.from(envelope);
    corrupted.writeUInt32BE(999999, headerLengthOffset);
    expect(() => parseEnvelope(corrupted)).toThrow(/truncated/i);
  });

  it('rejects a file that is too short to contain a valid header at all', () => {
    expect(() => parseEnvelope(Buffer.from('short'))).toThrow(/too short/i);
  });

  it('rejects an unparseable (non-JSON) header', () => {
    const envelope = buildValidEnvelope();
    const headerLengthOffset = ENVELOPE_MAGIC.length + 1;
    const headerLength = envelope.readUInt32BE(headerLengthOffset);
    const headerStart = headerLengthOffset + 4;
    const corrupted = Buffer.from(envelope);
    corrupted.fill(0x00, headerStart, headerStart + headerLength); // wipe the JSON header
    expect(() => parseEnvelope(corrupted)).toThrow(/not valid JSON/i);
  });

  it('rejects a header missing a required field', () => {
    const iv = Buffer.alloc(12, 1);
    const incompleteHeader = {
      formatVersion: FORMAT_VERSION,
      algorithm: 'AES-256-GCM',
      kmsKeyId: 'k',
      encryptedDataKey: 'blob',
      iv: iv.toString('base64'),
      // authTag intentionally omitted
      sourceDatabase: 'db',
      createdAtUtc: new Date().toISOString(),
    } as unknown as EnvelopeHeader;

    const envelope = serializeEnvelope(incompleteHeader, Buffer.from('ciphertext'));
    expect(() => parseEnvelope(envelope)).toThrow(/missing required field/i);
  });
});
