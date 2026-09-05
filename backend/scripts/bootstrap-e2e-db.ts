/**
 * Task #6 — provisions the isolated E2E database (migrate -> RLS ->
 * seed) before `npm run test:e2e` runs. Reuses the exact same
 * production-safety guard (buildE2EEnv) that test/setup-e2e-env.ts uses
 * for the app-boot path, so schema setup gets the identical hard-fail
 * protection — this script refuses to touch anything unless every
 * E2E_* variable is present and passes the "looks like an isolated test
 * resource" checks in test/e2e-env-guard.ts.
 *
 * Deliberately a thin orchestration script, not a reimplementation:
 * `prisma migrate deploy`, `npm run prisma:apply-rls`, and
 * `npm run prisma:seed` are the repository's existing, unmodified
 * mechanisms — this only supplies them with a validated DATABASE_URL via
 * the child process's environment (dotenv, used internally by both the
 * Prisma CLI and scripts/apply-rls.ts, never overwrites an already-set
 * process.env key, so this value wins over whatever backend/.env
 * contains).
 *
 * Usage: npm run test:e2e:bootstrap (requires the same E2E_* variables
 * as npm run test:e2e — see backend/.env.e2e.example).
 */
import { execSync } from 'node:child_process';
import { buildE2EEnv } from '../test/e2e-env-guard';

function run(command: string, env: NodeJS.ProcessEnv): void {
  console.log(`\n> ${command}`);
  execSync(command, { stdio: 'inherit', env, cwd: __dirname + '/..' });
}

function main(): void {
  const mapped = buildE2EEnv(process.env);
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: mapped.DATABASE_URL };

  console.log('E2E database bootstrap: env validated as an isolated test resource.');
  run('npx prisma migrate deploy', env);
  run('npm run prisma:apply-rls', env);
  run('npm run prisma:seed', env);
  console.log('\nE2E database bootstrap complete.');
}

main();
