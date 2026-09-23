import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { CarrierPaymentListPage } from './CarrierPaymentListPage';

const PAYMENT_ROW = {
  id: 'payment-1',
  paymentType: 'LINEHAUL',
  amount: '1200.00',
  status: 'APPROVED',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CarrierPaymentListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CarrierPaymentListPage — query error state', () => {
  it('shows QueryErrorState with a working Retry when the carrier payments query fails', async () => {
    let attempts = 0;
    server.use(
      http.get('/api/v1/carrier-payments', () => {
        attempts += 1;
        if (attempts === 1) return HttpResponse.json(null, { status: 500 });
        return HttpResponse.json([PAYMENT_ROW]);
      }),
    );

    renderPage();

    expect(
      await screen.findByText("Couldn't load carrier payments. Please try again."),
    ).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: 'Retry' });

    fireEvent.click(retryButton);

    await waitFor(() => expect(screen.getByText('LINEHAUL')).toBeInTheDocument());
    expect(attempts).toBe(2);
  });
});
