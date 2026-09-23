import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { CustomerListPage } from './CustomerListPage';

const CUSTOMER_ROW = {
  id: 'customer-1',
  legalName: 'Acme Freight',
  status: 'ACTIVE',
  primaryContactName: 'Jane Doe',
  billingCity: 'Dallas',
  billingState: 'TX',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CustomerListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CustomerListPage — query error state', () => {
  it('shows QueryErrorState with a working Retry when the customers query fails', async () => {
    let attempts = 0;
    server.use(
      http.get('/api/v1/customers', () => {
        attempts += 1;
        if (attempts === 1) return HttpResponse.json(null, { status: 500 });
        return HttpResponse.json([CUSTOMER_ROW]);
      }),
    );

    renderPage();

    expect(
      await screen.findByText("Couldn't load customers. Please try again."),
    ).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: 'Retry' });

    fireEvent.click(retryButton);

    await waitFor(() => expect(screen.getByText('Acme Freight')).toBeInTheDocument());
    expect(attempts).toBe(2);
  });
});
