/**
 * Dashboard Map Phase 2 — one-time (re-runnable) seed of GeocodeCache
 * from the bundled Census Gazetteer CSV (prisma/seed-data/). $0-cost,
 * offline, no external API call — see prisma/seed-data/README.md for
 * the dataset's provenance and processing.
 *
 * GeocodeCache is a shared, cross-tenant table (no organizationId), so
 * this runs a plain PrismaClient, not withTenantTransaction.
 *
 * Usage: npm run seed:geocode-cache
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

loadEnv({ path: join(__dirname, '..', '.env') });

const CSV_PATH = join(__dirname, '..', 'prisma', 'seed-data', 'us-places-gazetteer.csv');
const SOURCE = 'census-gazetteer';
const BATCH_SIZE = 2000;

interface GazetteerRow {
  lookupKey: string;
  lat: number;
  lng: number;
  source: string;
}

/**
 * Minimal quote-aware CSV line split — some Maryland/Virginia county
 * subdivision names embed a literal comma (e.g. `"District 1,
 * Abingdon"`), correctly double-quoted by the Python preprocessor's own
 * csv.writer. A naive `line.split(',')` misaligns those 359 rows'
 * columns; this handles exactly that one quoting rule (no escaped
 * quotes inside fields exist in this dataset — verified against the
 * source file).
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(): GazetteerRow[] {
  const raw = readFileSync(CSV_PATH, 'utf-8');
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const [header, ...dataLines] = lines;
  if (header.trim() !== 'city,state,lat,lng') {
    throw new Error(`Unexpected CSV header: "${header}" (expected "city,state,lat,lng")`);
  }

  return dataLines.map((line, index) => {
    const [city, state, lat, lng] = splitCsvLine(line);
    if (city === undefined || state === undefined || lat === undefined || lng === undefined) {
      throw new Error(`Malformed CSV row ${index + 2}: "${line}"`);
    }
    return {
      lookupKey: `${city.trim().toUpperCase()}|${state.trim().toUpperCase()}`,
      lat: Number(lat),
      lng: Number(lng),
      source: SOURCE,
    };
  });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const rows = parseCsv();
    console.log(`Parsed ${rows.length} rows from ${CSV_PATH}`);

    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const result = await prisma.geocodeCache.createMany({
        data: batch,
        skipDuplicates: true, // re-runnable: existing lookupKeys are left untouched
      });
      inserted += result.count;
      console.log(`  batch ${i / BATCH_SIZE + 1}: +${result.count} (of ${batch.length})`);
    }

    const total = await prisma.geocodeCache.count();
    console.log(
      `Done. Inserted ${inserted} new rows this run. GeocodeCache now has ${total} total rows.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('seed-geocode-cache failed:', error);
  process.exit(1);
});
