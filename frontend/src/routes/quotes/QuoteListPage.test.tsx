import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { QuoteListPage } from './QuoteListPage';

const QUOTE_ROW = {
  id: 'quote-1',
  status: 'OPEN',
  equipmentType: 'DRY_VAN',
  customerRate: '1800.00',
  expirationDate: '2026-02-01T00:00:00.000Z',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <QuoteListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('QuoteListPage — query error state', () => {
  it('shows QueryErrorState with a working Retry when the quotes query fails', async () => {
    let attempts = 0;
    server.use(
      http.get('/api/v1/quotes', () => {
        attempts += 1;
        if (attempts === 1) return HttpResponse.json(null, { status: 500 });
        return HttpResponse.json([QUOTE_ROW]);
      }),
    );

    renderPage();

    expect(await screen.findByText("Couldn't load quotes. Please try again.")).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: 'Retry' });

    fireEvent.click(retryButton);

    await waitFor(() => expect(screen.getByText('DRY VAN')).toBeInTheDocument());
    expect(attempts).toBe(2);
  });
});
