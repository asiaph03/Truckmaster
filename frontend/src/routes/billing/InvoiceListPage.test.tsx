import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { InvoiceListPage } from './InvoiceListPage';

const INVOICE_ROW = {
  id: 'invoice-1',
  invoiceNumber: 'INV-000001',
  status: 'SENT',
  customer: { id: 'customer-1', legalName: 'Acme Freight' },
  total: '1800.00',
  remainingBalance: '1800.00',
  dueDate: '2026-02-01T00:00:00.000Z',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <InvoiceListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InvoiceListPage — query error state', () => {
  it('shows QueryErrorState with a working Retry when the invoices query fails', async () => {
    let attempts = 0;
    server.use(
      http.get('/api/v1/invoices', () => {
        attempts += 1;
        if (attempts === 1) return HttpResponse.json(null, { status: 500 });
        return HttpResponse.json([INVOICE_ROW]);
      }),
    );

    renderPage();

    expect(
      await screen.findByText("Couldn't load invoices. Please try again."),
    ).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: 'Retry' });

    fireEvent.click(retryButton);

    await waitFor(() => expect(screen.getByText('INV-000001')).toBeInTheDocument());
    expect(attempts).toBe(2);
  });
});
