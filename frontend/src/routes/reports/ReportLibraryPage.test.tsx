import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { ReportLibraryPage } from './ReportLibraryPage';

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ReportLibraryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ReportLibraryPage — Frontend Phase 21', () => {
  it('renders exactly the categories/reports GET /reports/catalog returns — no client-side role mapping', async () => {
    server.use(
      http.get('/api/v1/reports/catalog', () =>
        HttpResponse.json({
          categories: [
            {
              key: 'OPERATIONS',
              label: 'Operations',
              reports: [{ id: 'load-volume', title: 'Load Volume' }],
            },
          ],
        }),
      ),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('Operations')).toBeInTheDocument());
    expect(screen.getByText('Load Volume')).toBeInTheDocument();
    expect(screen.queryByText('Financial')).not.toBeInTheDocument();
  });

  it('AR Aging / AP Aging cards link to the existing Billing routes, not a duplicated /reports/:id screen', async () => {
    server.use(
      http.get('/api/v1/reports/catalog', () =>
        HttpResponse.json({
          categories: [
            {
              key: 'AR_AP',
              label: 'AR/AP',
              reports: [
                { id: 'ar-aging', title: 'AR Aging', externalPath: '/billing/ar-aging' },
                { id: 'ap-aging', title: 'AP Aging', externalPath: '/billing/ap-aging' },
                { id: 'payment-history', title: 'Payment History' },
              ],
            },
          ],
        }),
      ),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('AR Aging')).toBeInTheDocument());
    expect(screen.getByText('AR Aging').closest('a')).toHaveAttribute('href', '/billing/ar-aging');
    expect(screen.getByText('AP Aging').closest('a')).toHaveAttribute('href', '/billing/ap-aging');
    expect(screen.getByText('Payment History').closest('a')).toHaveAttribute(
      'href',
      '/reports/payment-history',
    );
  });

  it('shows an empty state when no categories are visible (e.g. Compliance Reviewer)', async () => {
    server.use(http.get('/api/v1/reports/catalog', () => HttpResponse.json({ categories: [] })));

    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/no reports are available/i)).toBeInTheDocument(),
    );
  });
});
