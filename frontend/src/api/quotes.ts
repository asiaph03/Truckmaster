import { notImplemented } from './notImplemented';

export interface QuoteListFilters {
  status?: string;
  customerId?: string;
}

/** Typed surface only — real implementations land in Phase 3. */
export const quotesApi = {
  list: (_filters?: QuoteListFilters): Promise<unknown[]> => notImplemented('quotesApi.list'),
  getById: (_id: string): Promise<unknown> => notImplemented('quotesApi.getById'),
  create: (_body: unknown): Promise<unknown> => notImplemented('quotesApi.create'),
  markLost: (_id: string, _body: unknown): Promise<unknown> => notImplemented('quotesApi.markLost'),
  convert: (_id: string): Promise<unknown> => notImplemented('quotesApi.convert'),
};
