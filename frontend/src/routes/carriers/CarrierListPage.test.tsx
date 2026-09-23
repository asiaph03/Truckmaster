import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { CarrierListPage } from './CarrierListPage';

const CARRIER_ROW = {
  id: 'carrier-1',
  legalName: 'Acme Trucking',
  mcNumber: 'MC-100',
  dotNumber: 'DOT-100',
  status: 'ACTIVE',
  assignmentEligible: true,
  ineligibilityReasons: [],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CarrierListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CarrierListPage — query error state', () => {
  it('shows QueryErrorState with a working Retry when the carriers query fails', async () => {
    let attempts = 0;
    server.use(
      http.get('/api/v1/carriers', () => {
        attempts += 1;
        if (attempts === 1) return HttpResponse.json(null, { status: 500 });
        return HttpResponse.json([CARRIER_ROW]);
      }),
    );

    renderPage();

    expect(
      await screen.findByText("Couldn't load carriers. Please try again."),
    ).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: 'Retry' });

    fireEvent.click(retryButton);

    await waitFor(() => expect(screen.getByText('Acme Trucking')).toBeInTheDocument());
    expect(attempts).toBe(2);
  });
});
