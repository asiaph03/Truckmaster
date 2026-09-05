import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { ToastViewport } from '../../components/ui';
import { CarrierPaymentDetailPage } from './CarrierPaymentDetailPage';
import type { CarrierPayment } from '../../api';

const CARRIER = { id: 'carrier-1', legalName: 'MG Cargo Inc' };
const LOAD = { id: 'load-1', loadNumber: 'LOAD-000001' };

const PAYMENT: CarrierPayment = {
  id: 'payment-1',
  organizationId: 'org-1',
  loadId: 'load-1',
  carrierId: 'carrier-1',
  amount: '500.00',
  paymentType: 'DEPOSIT',
  status: 'DRAFT',
  preparedByUserId: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderPage(paymentId = PAYMENT.id) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/billing/carrier-pay/${paymentId}`]}>
        <Routes>
          <Route path="/billing/carrier-pay/:id" element={<CarrierPaymentDetailPage />} />
        </Routes>
      </MemoryRouter>
      <ToastViewport />
    </QueryClientProvider>,
  );
}

describe('CarrierPaymentDetailPage — initial load failure recovery (Task #4)', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
  });

  it('shows an error state (not stuck Loading) when the initial GET fails, and Retry recovers it', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let callCount = 0;
    server.use(
      http.get('/api/v1/carrier-payments/payment-1', () => {
        callCount += 1;
        if (callCount === 1) {
          return HttpResponse.json(
            { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
            { status: 500 },
          );
        }
        return HttpResponse.json(PAYMENT);
      }),
      http.get('/api/v1/carriers/carrier-1', () => HttpResponse.json(CARRIER)),
      http.get('/api/v1/loads/load-1', () => HttpResponse.json(LOAD)),
    );

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText("Couldn't load this carrier payment. Please try again."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'DEPOSIT — $500.00' })).toBeInTheDocument(),
    );
    expect(callCount).toBe(2);
  });
});
