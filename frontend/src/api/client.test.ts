import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../test/mswServer';
import { apiRequest, setUnauthorizedHandler } from './client';
import { ApiError } from './errors';

describe('apiRequest', () => {
  it('returns the parsed JSON body on success', async () => {
    server.use(
      http.get('/api/v1/customers/abc', () => HttpResponse.json({ id: 'abc', legalName: 'Acme' })),
    );

    const result = await apiRequest<{ id: string; legalName: string }>('/customers/abc');
    expect(result).toEqual({ id: 'abc', legalName: 'Acme' });
  });

  it('sends query params and JSON body correctly', async () => {
    server.use(
      http.get('/api/v1/customers', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('status')).toBe('ACTIVE');
        return HttpResponse.json([]);
      }),
    );

    await apiRequest('/customers', { query: { status: 'ACTIVE', unset: undefined } });
  });

  it('throws an ApiError with the code/message/details from the error envelope', async () => {
    server.use(
      http.post('/api/v1/customers', () =>
        HttpResponse.json(
          {
            error: {
              code: 'CONFLICT',
              message: 'Duplicate found.',
              details: { reasonCode: 'POSSIBLE_DUPLICATE_CUSTOMER' },
            },
          },
          { status: 409 },
        ),
      ),
    );

    await expect(apiRequest('/customers', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'Duplicate found.',
      details: { reasonCode: 'POSSIBLE_DUPLICATE_CUSTOMER' },
    });
  });

  it('invokes the registered unauthorized handler on a 401, and still throws', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    server.use(
      http.get('/api/v1/auth/me', () =>
        HttpResponse.json(
          { error: { code: 'AUTHENTICATION_ERROR', message: 'Authentication required.' } },
          { status: 401 },
        ),
      ),
    );

    await expect(apiRequest('/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
    setUnauthorizedHandler(() => {});
  });

  describe('Beta Launch Hardening — CSRF header', () => {
    afterEach(() => {
      // jsdom has no direct "clear all cookies" API — expire it explicitly.
      document.cookie = 'csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    });

    it('attaches X-CSRF-Token, read from the csrf_token cookie, on a non-GET request', async () => {
      document.cookie = 'csrf_token=test-token-value';
      let receivedHeader: string | null = null;
      server.use(
        http.post('/api/v1/customers', ({ request }) => {
          receivedHeader = request.headers.get('X-CSRF-Token');
          return HttpResponse.json({ id: 'new-1' }, { status: 201 });
        }),
      );

      await apiRequest('/customers', { method: 'POST', body: { legalName: 'Acme' } });
      expect(receivedHeader).toBe('test-token-value');
    });

    it('does not attach the header on a GET request (safe method)', async () => {
      document.cookie = 'csrf_token=test-token-value';
      let receivedHeader: string | null = 'unset';
      server.use(
        http.get('/api/v1/customers/abc', ({ request }) => {
          receivedHeader = request.headers.get('X-CSRF-Token');
          return HttpResponse.json({ id: 'abc' });
        }),
      );

      await apiRequest('/customers/abc');
      expect(receivedHeader).toBeNull();
    });

    it('sends no CSRF header at all when no cookie has been issued yet', async () => {
      let receivedHeader: string | null = 'unset';
      server.use(
        http.post('/api/v1/customers', ({ request }) => {
          receivedHeader = request.headers.get('X-CSRF-Token');
          return HttpResponse.json({ id: 'new-1' }, { status: 201 });
        }),
      );

      await apiRequest('/customers', { method: 'POST', body: {} });
      expect(receivedHeader).toBeNull();
    });
  });

  describe('Beta Launch Hardening — VITE_API_BASE_URL (Vercel + Render)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('falls back to the relative /api/v1 path when VITE_API_BASE_URL is unset (local dev, Docker/nginx same-origin)', async () => {
      vi.stubEnv('VITE_API_BASE_URL', undefined);
      vi.resetModules();
      const { API_BASE } = await import('./client');
      expect(API_BASE).toBe('/api/v1');
    });

    it('targets the configured absolute Render origin when VITE_API_BASE_URL is set', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/api/v1');
      vi.resetModules();
      const { API_BASE } = await import('./client');
      expect(API_BASE).toBe('https://api.example.com/api/v1');
    });

    it('apiRequest resolves to the absolute origin end-to-end when VITE_API_BASE_URL is set', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/api/v1');
      vi.resetModules();
      const { apiRequest: freshApiRequest } = await import('./client');
      server.use(
        http.get('https://api.example.com/api/v1/customers/abc', () =>
          HttpResponse.json({ id: 'abc', legalName: 'Acme' }),
        ),
      );

      const result = await freshApiRequest<{ id: string; legalName: string }>('/customers/abc');
      expect(result).toEqual({ id: 'abc', legalName: 'Acme' });
    });
  });

  describe('Beta Launch Hardening — raw-fetch export/download paths honor VITE_API_BASE_URL', () => {
    beforeEach(() => {
      // jsdom has no Blob URL registry — stub the same way every other
      // CSV-export test in this codebase does (e.g. DispatchBoardPage.test.tsx).
      URL.createObjectURL = vi.fn(() => 'blob:mock');
      URL.revokeObjectURL = vi.fn();
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
      vi.restoreAllMocks();
    });

    it('documentsApi.exportSearchCsv targets the configured absolute origin', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/api/v1');
      vi.resetModules();
      const { documentsApi } = await import('./documents');
      let hit = false;
      server.use(
        http.get('https://api.example.com/api/v1/documents/search/export', () => {
          hit = true;
          return HttpResponse.text('id,name\n', {
            headers: { 'Content-Type': 'text/csv' },
          });
        }),
      );

      await documentsApi.exportSearchCsv({});
      expect(hit).toBe(true);
    });

    it('loadsApi.exportSearchCsv targets the configured absolute origin', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/api/v1');
      vi.resetModules();
      const { loadsApi } = await import('./loads');
      let hit = false;
      server.use(
        http.get('https://api.example.com/api/v1/loads/search/export', () => {
          hit = true;
          return HttpResponse.text('id,loadNumber\n', {
            headers: { 'Content-Type': 'text/csv' },
          });
        }),
      );

      await loadsApi.exportSearchCsv({});
      expect(hit).toBe(true);
    });

    it('reportCatalogApi export (downloadCsv) targets the configured absolute origin', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/api/v1');
      vi.resetModules();
      const { reportCatalogApi } = await import('./reportCatalog');
      let hit = false;
      server.use(
        http.get('https://api.example.com/api/v1/reports/payment-history/export', () => {
          hit = true;
          return HttpResponse.text('id,type\n', { headers: { 'Content-Type': 'text/csv' } });
        }),
      );

      await reportCatalogApi.paymentHistoryExportCsv({});
      expect(hit).toBe(true);
    });

    it('reportingApi export (downloadCsv) targets the configured absolute origin', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/api/v1');
      vi.resetModules();
      const { reportingApi } = await import('./reporting');
      let hit = false;
      server.use(
        http.get('https://api.example.com/api/v1/reports/ar-aging/export', () => {
          hit = true;
          return HttpResponse.text('bucket,total\n', {
            headers: { 'Content-Type': 'text/csv' },
          });
        }),
      );

      await reportingApi.arAgingExportCsv();
      expect(hit).toBe(true);
    });
  });
});
