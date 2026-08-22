import { notImplemented } from './notImplemented';

/** Typed surface only — real implementation (minimal Dashboard) lands in Phase 5. */
export const reportingApi = {
  search: (_q: string): Promise<unknown> => notImplemented('reportingApi.search'),
  arAging: (): Promise<unknown> => notImplemented('reportingApi.arAging'),
  apAging: (): Promise<unknown> => notImplemented('reportingApi.apAging'),
  dashboard: (): Promise<unknown> => notImplemented('reportingApi.dashboard'),
  // NOTE: the broader Operations/Financial/Carrier-Performance/Sales
  // report library, CSV/Excel export, and saved views have no backend
  // endpoints — deferred to Phase 6 per the approved gap analysis.
};
