/**
 * Applies every RLS SQL file in prisma/rls/, in filename order, to
 * whatever database DATABASE_URL points at.
 *
 * Run AFTER `prisma migrate deploy` (or `migrate dev`) — RLS policies
 * reference tables that must already exist. See prisma/rls/README.md.
 *
 * Usage: npm run prisma:apply-rls
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Unlike the `prisma` CLI (which auto-loads `.env` internally — this is
// why `prisma migrate deploy` works without this line but a plain
// ts-node script does not), nothing loads environment variables for this
// standalone script by default. Must run before `new PrismaClient()`
// below, which reads DATABASE_URL at construction time. Resolved
// relative to this file, matching the same __dirname-relative pattern
// already used for rlsDir below, so it works regardless of the caller's
// cwd.
loadEnv({ path: join(__dirname, '..', '.env') });

async function main() {
  const rlsDir = join(__dirname, '..', 'prisma', 'rls');
  const files = readdirSync(rlsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // numeric prefix (0001_, 0002_, ...) controls order

  if (files.length === 0) {
    console.log('No RLS SQL files found in prisma/rls/ — nothing to apply.');
    return;
  }

  const prisma = new PrismaClient();
  try {
    for (const file of files) {
      const raw = readFileSync(join(rlsDir, file), 'utf-8');
      console.log(`Applying RLS: ${file}`);

      // Prisma's raw-query methods execute one statement per call — the
      // node-postgres driver underneath does not reliably support
      // multi-statement strings. Split into individual statements and run
      // them in order. This is a naive `;`-based split, safe here only
      // because these RLS files are hand-authored and simple (no
      // semicolons inside string literals/function bodies) — not a
      // general-purpose SQL statement splitter.
      //
      // Comment lines are stripped from each chunk (not just checked on
      // the chunk's first line) before deciding whether it's empty: a
      // chunk that is a `--` comment block immediately followed by a real
      // statement — e.g. an explanatory comment directly above an ALTER
      // TABLE, with no other `;` in between — previously had its whole
      // chunk (comment AND the real statement after it) silently dropped,
      // because the old check only looked at whether the chunk *started*
      // with `--`. That silently skipped ENABLE ROW LEVEL SECURITY for
      // every table whose statement happened to be preceded by a comment
      // — a real, deterministic bug, confirmed by re-deriving live
      // pg_class.relrowsecurity state after a from-scratch reset.
      const statements = raw
        .split(/;\s*(?:\n|$)/)
        .map((chunk) =>
          chunk
            .split('\n')
            .filter((line) => !line.trim().startsWith('--'))
            .join('\n')
            .trim(),
        )
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        // Policies/ALTER TABLE statements are not parameterizable and are
        // never built from user input (these are static, repo-committed
        // files) — $executeRawUnsafe is appropriate here specifically
        // because the SQL is fixed migration content, not request data.
        await prisma.$executeRawUnsafe(statement);
      }
    }
    console.log(`Applied ${files.length} RLS file(s) successfully.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Failed to apply RLS policies:', err);
  process.exit(1);
});
