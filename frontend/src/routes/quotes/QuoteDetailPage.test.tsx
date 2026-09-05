import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { ToastViewport } from '../../components/ui';
import { QuoteDetailPage } from './QuoteDetailPage';
import type { Quote } from '../../api';

const CUSTOMER = { id: 'cust-1', legalName: 'Acme Freight' };

const QUOTE: Quote = {
  id: 'quote-1',
  customerId: 'cust-1',
  stops: [],
  equipmentType: 'DRY_VAN',
  customerRate: '1200.00',
  rateSource: 'MANUAL',
  rateAgreementId: null,
  expirationDate: '2026-02-01T00:00:00.000Z',
  status: 'OPEN',
  createdByUserId: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderPage(quoteId = QUOTE.id) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/quotes/${quoteId}`]}>
        <Routes>
          <Route path="/quotes/:id" element={<QuoteDetailPage />} />
        </Routes>
      </MemoryRouter>
      <ToastViewport />
    </QueryClientProvider>,
  );
}

describe('QuoteDetailPage — initial load failure recovery (Task #4)', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
  });

  it('shows an error state (not stuck Loading) when the initial GET fails, and Retry recovers it', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let callCount = 0;
    server.use(
      http.get('/api/v1/quotes/quote-1', () => {
        callCount += 1;
        if (callCount === 1) {
          return HttpResponse.json(
            { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
            { status: 500 },
          );
        }
        return HttpResponse.json(QUOTE);
      }),
      http.get('/api/v1/customers/cust-1', () => HttpResponse.json(CUSTOMER)),
    );

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Couldn't load this quote. Please try again.")).toBeInTheDocument(),
    );
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Quote' })).toBeInTheDocument());
    expect(callCount).toBe(2);
  });
});
