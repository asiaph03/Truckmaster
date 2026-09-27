# us-places-gazetteer.csv

Offline US city/state → coordinate dataset backing `GeocodeCache`'s
`census-gazetteer` rows. $0-cost, public-domain, no external API — this
is the entire Phase 2 location-resolution data source.

## Provenance

Built from two US Census Bureau Gazetteer Files (2026 vintage,
published 2026-09-08, public domain — 17 U.S.C. §105, no attribution
legally required):

- `2026_Gaz_place_national.zip` — incorporated places + Census
  Designated Places (CDPs). Source of truth first; wins on any
  city/state key collision.
- `2026_Gaz_cousubs_national.zip` — county subdivisions (minor civil
  divisions). Needed because several Northeast/Midwest states (e.g. New
  Jersey) organize their entire area into townships rather than
  incorporated places, so the Places file alone misses real towns like
  "Edison, NJ" — confirmed directly: Edison does not appear in the
  Places file under NJ at all, only in County Subdivisions.

Both downloaded from https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2026_Gazetteer/

## Processing

Each source file's `NAME` column includes a legal/statistical suffix
(e.g. "Abbeville city", "Edison township", "Autaugaville CCD"). These
are stripped against a known list of Census designators so the lookup
key matches how a dispatcher actually types a city name (`Abbeville`,
`Edison`), then normalized to `CITY|STATE` (trim + uppercase) — the
exact same key format `frontend/src/lib/geocoding.ts` already uses, and
that `GeocodeCache.lookupKey` uses server-side.

Only the 50 states + DC are included (US territories excluded — out of
scope for domestic trucking). Places file loaded first; County
Subdivisions only fills keys not already present from Places.

## Result

47,415 unique `city,state,lat,lng` rows — versus the ~250 cities in the
frontend's previous hardcoded `usCityCentroids.ts`. A city/state pair
not in this file is not guessed at; it resolves to `UNRESOLVED`, same
honesty rule as the check-call/stop resolution it feeds.

## Known remaining gap

This dataset is still place/township-level, not full street-address
precision — the same city-centroid limitation the frontend dataset
always had, just with far larger coverage. An unincorporated hamlet or
a place renamed/merged since the 2026 vintage may still miss; that's
expected, not a bug — it resolves to `UNRESOLVED` rather than a wrong
guess.

## Refresh

Re-run `backend/scripts/seed-geocode-cache.ts` against a newer year's
Gazetteer Files (Census publishes annually) to refresh — no frontend
rebuild/redeploy required, since this is consumed entirely server-side.
