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
 * CORS: the presigned-upload flows (documents, Rate Confirmation intake)
 * have the browser PUT the file bytes directly to this server — a
 * cross-origin request from the Vite dev server's own origin
 * (`http://localhost:5173`), which never goes through the `/api` proxy.
 * Without a CORS rule the preflight is rejected outright (mirrors the
 * exact same requirement `.env.example` documents for the real
 * production bucket, just never previously set up for this local
 * fixture). Scoped to exactly the one local dev origin — no wildcard —
 * and only the three methods these upload flows actually use.
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

const LOCAL_FRONTEND_ORIGIN = 'http://localhost:5173';

const CORS_CONFIG = `<CORSConfiguration>
    <CORSRule>
        <AllowedOrigin>${LOCAL_FRONTEND_ORIGIN}</AllowedOrigin>
        <AllowedMethod>PUT</AllowedMethod>
        <AllowedMethod>GET</AllowedMethod>
        <AllowedMethod>HEAD</AllowedMethod>
        <AllowedHeader>Content-Type</AllowedHeader>
        <MaxAgeSeconds>3000</MaxAgeSeconds>
    </CORSRule>
</CORSConfiguration>`;

const server = new S3rver({
  address: HOST,
  port: PORT,
  directory: DATA_DIR,
  silent: false,
  vhostBuckets: false,
  configureBuckets: [{ name: BUCKET, configs: [CORS_CONFIG] }],
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
