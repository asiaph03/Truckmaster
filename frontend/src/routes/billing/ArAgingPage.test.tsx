import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { ArAgingPage } from './ArAgingPage';

const DATA = {
  buckets: {
    current: { count: 1, total: '100.00' },
    days1to30: { count: 0, total: '0.00' },
    days31to60: { count: 0, total: '0.00' },
    days61to90: { count: 0, total: '0.00' },
    days90plus: { count: 0, total: '0.00' },
  },
  grandTotal: '100.00',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArAgingPage />
    </QueryClientProvider>,
  );
}

describe('ArAgingPage — query error state', () => {
  it('shows QueryErrorState with a working Retry when the ar-aging query fails', async () => {
    let attempts = 0;
    server.use(
      http.get('/api/v1/reports/ar-aging', () => {
        attempts += 1;
        if (attempts === 1) return HttpResponse.json(null, { status: 500 });
        return HttpResponse.json(DATA);
      }),
    );

    renderPage();

    expect(
      await screen.findByText("Couldn't load AR Aging. Please try again."),
    ).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: 'Retry' });

    fireEvent.click(retryButton);

    await waitFor(() => expect(screen.getAllByText('Current').length).toBeGreaterThan(0));
    expect(attempts).toBe(2);
  });
});
