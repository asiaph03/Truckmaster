import { describe, expect, it, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { ReportDetailPage } from './ReportDetailPage';

function renderReport(reportId: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(
    http.get('/api/v1/customers', () => HttpResponse.json([])),
    http.get('/api/v1/carriers', () => HttpResponse.json([])),
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/reports/${reportId}`]}>
        <Routes>
          <Route path="/reports/:reportId" element={<ReportDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ReportDetailPage — Frontend Phase 21', () => {
  it('an unknown reportId shows an empty state rather than crashing', () => {
    renderReport('not-a-real-report');
    expect(screen.getByText('This report does not exist.')).toBeInTheDocument();
  });

  it('renders a plain report (Dispatcher Workload) from its own endpoint', async () => {
    server.use(
      http.get('/api/v1/reports/dispatcher-workload', () =>
        HttpResponse.json({
          items: [
            {
              dispatcherId: 'd1',
              dispatcherName: 'Jane Dispatcher',
              loadsAssigned: 5,
              active: 2,
              deliveredOrClosed: 3,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 50,
        }),
      ),
    );

    renderReport('dispatcher-workload');

    await waitFor(() => expect(screen.getByText('Jane Dispatcher')).toBeInTheDocument());
    const table = screen.getByRole('table');
    expect(within(table).getByText('5')).toBeInTheDocument();
  });

  it('Revenue & Margin sends the selected groupBy and toggling Compare requests a previousPeriod', async () => {
    const receivedUrls: string[] = [];
    server.use(
      http.get('/api/v1/reports/revenue-margin', ({ request }) => {
        receivedUrls.push(request.url);
        return HttpResponse.json({
          items: [
            {
              groupKey: 'cust-1',
              groupLabel: 'Acme Freight',
              loadCount: 2,
              revenue: '1000.00',
              cost: '600.00',
              grossProfit: '400.00',
              marginPercent: '40.00',
            },
          ],
          total: 1,
          page: 1,
          pageSize: 50,
          previousPeriod: [
            {
              groupKey: 'cust-1',
              groupLabel: 'Acme Freight',
              loadCount: 1,
              revenue: '500.00',
              cost: '300.00',
              grossProfit: '200.00',
              marginPercent: '40.00',
            },
          ],
        });
      }),
    );

    renderReport('revenue-margin');

    await waitFor(() => expect(screen.getByText('Acme Freight')).toBeInTheDocument());
    expect(receivedUrls[0]).toContain('groupBy=CUSTOMER');

    fireEvent.click(screen.getByText('Compare to previous period'));
    await waitFor(() => expect(receivedUrls.some((u) => u.includes('compare=true'))).toBe(true));
    await waitFor(() => expect(screen.getByText('Previous Period')).toBeInTheDocument());
  });

  it('Carrier Performance renders a redacted cost column as "—", never the literal string "null"', async () => {
    server.use(
      http.get('/api/v1/reports/carrier-performance', () =>
        HttpResponse.json({
          items: [
            {
              carrierId: 'carrier-1',
              carrierLegalName: 'Eligible Carrier',
              loadCount: 5,
              rejectionRatePercent: '20.00',
              onTimePercent: '90.00',
              totalCost: null,
              avgCostPerLoad: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 50,
        }),
      ),
    );

    renderReport('carrier-performance');

    await waitFor(() => expect(screen.getByText('Eligible Carrier')).toBeInTheDocument());
    expect(screen.queryByText('null')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('Payment History defaults to a 90-day date range and Export CSV triggers a download', async () => {
    server.use(
      http.get('/api/v1/reports/payment-history', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 50, truncated: false }),
      ),
    );
    let exportUrl: string | undefined;
    server.use(
      http.get('/api/v1/reports/payment-history/export', ({ request }) => {
        exportUrl = request.url;
        return new HttpResponse('Date,Type\r\n', { headers: { 'Content-Type': 'text/csv' } });
      }),
    );
    URL.createObjectURL = () => 'blob:mock';
    URL.revokeObjectURL = () => {};
    // jsdom has no object-URL/download plumbing and logs an unhandled
    // "navigation not implemented" error if the anchor's real click-to-
    // navigate behavior runs — stub it, matching LoadSearchPage.test.tsx's
    // own established pattern.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderReport('payment-history');

    await waitFor(() =>
      expect(screen.getByText('No data matches your filters.')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText('Export CSV'));
    await waitFor(() => expect(exportUrl).toBeDefined());
    expect(exportUrl).toContain('dateFrom=');
    expect(exportUrl).toContain('dateTo=');
    clickSpy.mockRestore();
  });
});
