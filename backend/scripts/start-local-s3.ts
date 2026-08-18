/**
 * Local S3-compatible object storage for native-Windows development —
 * runs `s3rver` (a plain npm package, no binary download / Docker / WSL
 * required) bound to the same host/port/bucket `.env.example` already
 * points `StorageService` at. Does not change the application's
 * architecture: StorageService only ever talks to "an S3-compatible
 * endpoint" (TECHNICAL_ARCHITECTURE.md §1.3, Decision 9) — this script
 * just decides what's listening on that endpoint for local dev.
 *
 * `configureBuckets` creates `tms-documents` automatically on every
 * startup, so there is no separate one-time "create the bucket" step
 * (unlike the native-MinIO path this replaces).
 *
 * `vhostBuckets: false` matches `S3_FORCE_PATH_STYLE=true` in
 * `.env.example` — StorageService's S3Client sends path-style requests
 * (`http://host:port/bucket/key`), so the server must expect the same.
 *
 * Usage: npm run s3:local
 * Leave running in its own terminal alongside `npm run start:dev`.
 */
import { join } from 'node:path';
import S3rver from 's3rver';

const HOST = '127.0.0.1';
const PORT = 9000;
const BUCKET = 'tms-documents';
const DATA_DIR = join(__dirname, '..', '.local-s3-data');

const server = new S3rver({
  address: HOST,
  port: PORT,
  directory: DATA_DIR,
  silent: false,
  vhostBuckets: false,
  configureBuckets: [{ name: BUCKET, configs: [] }],
});

server.run().then(
  (address) => {
    console.log(
      `Local S3-compatible storage (s3rver) listening on http://${address.address === '::' ? HOST : address.address}:${address.port}`,
    );
    console.log(`Bucket "${BUCKET}" created automatically. Data directory: ${DATA_DIR}`);
  },
  (err) => {
    console.error('Failed to start local S3 server:', err);
    process.exit(1);
  },
);
