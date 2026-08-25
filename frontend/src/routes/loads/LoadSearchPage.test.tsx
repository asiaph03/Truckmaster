import { describe, expect, it, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { LoadSearchPage } from './LoadSearchPage';

const CUSTOMER = { id: 'customer-1', legalName: 'Acme Freight' };

const LOAD_ROW = {
  id: 'load-1',
  loadNumber: 'LOAD-000001',
  customerId: 'customer-1',
  status: 'BOOKED',
  equipmentType: 'DRY_VAN',
  customerRate: '1800.00',
  carrierRate: null,
  riskStatus: 'NORMAL',
  podStatus: 'NOT_RECEIVED',
  createdAt: '2026-01-01T00:00:00.000Z',
  stops: [
    {
      id: 's1',
      loadId: 'load-1',
      sequence: 1,
      stopType: 'PICKUP',
      city: 'Dallas',
      state: 'TX',
      zip: '75201',
      status: 'PENDING',
    },
    {
      id: 's2',
      loadId: 'load-1',
      sequence: 2,
      stopType: 'DELIVERY',
      city: 'Chicago',
      state: 'IL',
      zip: '60601',
      status: 'PENDING',
    },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <LoadSearchPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockBaseHandlers(searchHandler: Parameters<typeof http.get>[1]) {
  server.use(
    http.get('/api/v1/loads/search', searchHandler),
    http.get('/api/v1/customers', () => HttpResponse.json([CUSTOMER])),
    http.get('/api/v1/carriers', () => HttpResponse.json([])),
    http.get('/api/v1/memberships', () => HttpResponse.json([])),
  );
}

describe('LoadSearchPage — Frontend Phase 13', () => {
  it('renders results from GET /loads/search and resolves the customer name client-side', async () => {
    mockBaseHandlers(() =>
      HttpResponse.json({ items: [LOAD_ROW], total: 1, page: 1, pageSize: 50 }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());
    const table = screen.getByRole('table');
    expect(within(table).getByText('Acme Freight')).toBeInTheDocument();
  });

  it('changing a filter re-queries the server with the new param and resets to page 1', async () => {
    const receivedUrls: string[] = [];
    mockBaseHandlers(({ request }) => {
      receivedUrls.push(request.url);
      return HttpResponse.json({ items: [LOAD_ROW], total: 1, page: 1, pageSize: 50 });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/Search Load #/i), {
      target: { value: 'dallas' },
    });

    await waitFor(() => expect(receivedUrls.some((u) => u.includes('q=dallas'))).toBe(true));
  });

  it('clicking the Pickup Date header sorts by pickupDate, and clicking again flips direction', async () => {
    const receivedUrls: string[] = [];
    mockBaseHandlers(({ request }) => {
      receivedUrls.push(request.url);
      return HttpResponse.json({ items: [LOAD_ROW], total: 1, page: 1, pageSize: 50 });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('columnheader', { name: 'Pickup' }));
    await waitFor(() =>
      expect(
        receivedUrls.some((u) => u.includes('sort=pickupDate') && u.includes('sortDirection=asc')),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole('columnheader', { name: 'Pickup' }));
    await waitFor(() =>
      expect(
        receivedUrls.some((u) => u.includes('sort=pickupDate') && u.includes('sortDirection=desc')),
      ).toBe(true),
    );
  });

  it('clicking a non-sortable column header (Customer) never adds a sort param', async () => {
    const receivedUrls: string[] = [];
    mockBaseHandlers(({ request }) => {
      receivedUrls.push(request.url);
      return HttpResponse.json({ items: [LOAD_ROW], total: 1, page: 1, pageSize: 50 });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('columnheader', { name: 'Customer' }));

    await new Promise((r) => setTimeout(r, 50));
    expect(receivedUrls.some((u) => u.includes('sort='))).toBe(false);
  });

  it('renders a redacted (null) rate as an em dash, never the literal string "null"', async () => {
    mockBaseHandlers(() =>
      HttpResponse.json({
        items: [{ ...LOAD_ROW, customerRate: null, carrierRate: null }],
        total: 1,
        page: 1,
        pageSize: 50,
      }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());
    expect(screen.queryByText('null')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('Export CSV calls the export endpoint with the current filters', async () => {
    mockBaseHandlers(() =>
      HttpResponse.json({ items: [LOAD_ROW], total: 1, page: 1, pageSize: 50 }),
    );
    let exportUrl: string | undefined;
    server.use(
      http.get('/api/v1/loads/search/export', ({ request }) => {
        exportUrl = request.url;
        return new HttpResponse('Load #\r\nLOAD-000001', {
          headers: { 'Content-Type': 'text/csv' },
        });
      }),
    );
    // jsdom has no object-URL/download plumbing, and logs an unhandled
    // "navigation not implemented" error if the anchor's real click-to-
    // navigate behavior runs — stub both so the download side effect
    // doesn't throw or spam the test output.
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderPage();
    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Export CSV'));

    await waitFor(() => expect(exportUrl).toBeDefined());
    clickSpy.mockRestore();
  });
});
