/**
 * Dashboard Map Phase 2 — historical backfill for CheckCall/Stop rows that
 * predate this feature. All resolution-prediction and eligibility logic
 * lives in LocationResolutionBackfillService (src/common/location-resolution/
 * services/location-resolution-backfill.service.ts) — this file is a thin
 * CLI wrapper: parse the mode flag, wire up real Prisma/Redis/Queue
 * connections, run it, print the report.
 *
 * Usage:
 *   npm run backfill:location-resolution            (dry run — default, zero writes, zero enqueues)
 *   npm run backfill:location-resolution -- --execute (enqueues real BullMQ jobs onto the
 *                                                       existing `resolve-location` queue;
 *                                                       the already-deployed LocationResolutionWorker
 *                                                       performs the actual writes, same as any live
 *                                                       Check Call/Stop — this script itself never
 *                                                       calls .update()/.create() on any table)
 */
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: join(__dirname, '..', '.env') });

import 'reflect-metadata';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { LocationResolutionService } from '../src/common/location-resolution/services/location-resolution.service';
import { LocationResolutionBackfillService } from '../src/common/location-resolution/services/location-resolution-backfill.service';
import { LOCATION_RESOLUTION_QUEUE_NAME } from '../src/common/location-resolution/location-resolution.constants';

const DRY_RUN = !process.argv.includes('--execute');

async function main() {
  console.log(
    `Mode: ${DRY_RUN ? 'DRY RUN (zero writes, zero enqueues)' : 'EXECUTE (will enqueue BullMQ jobs)'}`,
  );

  const prisma = new PrismaService();
  const locationResolution = new LocationResolutionService(prisma);
  const backfill = new LocationResolutionBackfillService(prisma, locationResolution);

  let redis: Redis | undefined;
  let queue: Queue | undefined;
  if (!DRY_RUN) {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    queue = new Queue(LOCATION_RESOLUTION_QUEUE_NAME, { connection: redis });
  }

  try {
    const report = await backfill.run({ dryRun: DRY_RUN, queue });

    console.log('\n=== TOTALS ===');
    console.log('CheckCalls:', JSON.stringify(report.totals.checkCalls, null, 2));
    console.log('Stops:', JSON.stringify(report.totals.stops, null, 2));
    console.log('Loads:', JSON.stringify(report.totals.loads, null, 2));

    console.log('\n=== PER-ORGANIZATION ===');
    for (const org of report.perOrganization) {
      console.log(`\n${org.organizationName} (${org.organizationId})`);
      console.log('  CheckCalls:', JSON.stringify(org.checkCalls));
      console.log('  Stops:', JSON.stringify(org.stops));
      console.log('  Loads:', JSON.stringify(org.loads));
    }

    console.log('\n=== SAMPLES ===');
    console.log(JSON.stringify(report.samples, null, 2));

    console.log(`\nJobs enqueued this run: ${report.jobsEnqueued}`);
    console.log(
      DRY_RUN
        ? '\nDRY RUN complete — no writes, no enqueues occurred.'
        : '\nEXECUTE complete — jobs enqueued; the LocationResolutionWorker will process them asynchronously.',
    );
  } finally {
    await prisma.$disconnect();
    if (queue) await queue.close();
    if (redis) await redis.quit();
  }
}

main().catch((error) => {
  console.error('backfill-location-resolution failed:', error);
  process.exit(1);
});
