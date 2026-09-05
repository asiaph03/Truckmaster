import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { ToastViewport } from '../../components/ui';
import { InvoiceDetailPage } from './InvoiceDetailPage';
import type { Invoice } from '../../api';

const CUSTOMER = { id: 'cust-1', legalName: 'Acme Freight' };

const INVOICE: Invoice = {
  id: 'invoice-1',
  invoiceNumber: 'INV-000001',
  status: 'DRAFT',
  customerId: 'cust-1',
  total: '1000.00',
  remainingBalance: '1000.00',
  dueDate: '2026-02-01',
  createdAt: '2026-01-01T00:00:00.000Z',
  createdByUserId: 'user-1',
  lineItems: [],
  payments: [],
  adjustments: [],
  invoiceLoads: [],
};

function renderPage(invoiceId = INVOICE.id) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/billing/invoices/${invoiceId}`]}>
        <Routes>
          <Route path="/billing/invoices/:id" element={<InvoiceDetailPage />} />
        </Routes>
      </MemoryRouter>
      <ToastViewport />
    </QueryClientProvider>,
  );
}

describe('InvoiceDetailPage — initial load failure recovery (Task #4)', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
  });

  it('shows an error state (not stuck Loading) when the initial GET fails, and Retry recovers it', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let callCount = 0;
    server.use(
      http.get('/api/v1/invoices/invoice-1', () => {
        callCount += 1;
        if (callCount === 1) {
          return HttpResponse.json(
            { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
            { status: 500 },
          );
        }
        return HttpResponse.json(INVOICE);
      }),
      http.get('/api/v1/customers/cust-1', () => HttpResponse.json(CUSTOMER)),
    );

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Couldn't load this invoice. Please try again.")).toBeInTheDocument(),
    );
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'INV-000001' })).toBeInTheDocument(),
    );
    expect(callCount).toBe(2);
  });
});
