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
import { PrismaClient } from '@prisma/client';

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
      const statements = raw
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('--'));

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
