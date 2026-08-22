import { apiRequest } from './client';
import { notImplemented } from './notImplemented';

export interface GlobalSearchResult {
  loads: unknown[];
  customers: { id: string; legalName: string; status: string }[];
  carriers: { id: string; legalName: string; status: string }[];
  invoices: unknown[];
}

export const reportingApi = {
  search: (q: string) => apiRequest<GlobalSearchResult>('/search', { query: { q } }),

  // Typed surface only — real implementations land in Phase 5.
  arAging: (): Promise<unknown> => notImplemented('reportingApi.arAging'),
  apAging: (): Promise<unknown> => notImplemented('reportingApi.apAging'),
  dashboard: (): Promise<unknown> => notImplemented('reportingApi.dashboard'),
  // NOTE: the broader Operations/Financial/Carrier-Performance/Sales
  // report library, CSV/Excel export, and saved views have no backend
  // endpoints — deferred to a later phase per the approved gap analysis.
};
