import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { useSessionStore } from '../../../auth/session-store';
import { ToastViewport } from '../../../components/ui';
import { DriversTab } from './DriversTab';
import type { Carrier } from '../../../api';

const CARRIER: Carrier = {
  id: 'carrier-1',
  legalName: 'MG Cargo Inc',
  dba: '',
  mcNumber: '042939',
  dotNumber: '1234567',
  addressLine1: '200 Dock Rd',
  city: 'Tampa',
  state: 'FL',
  zip: '33602',
  primaryContactName: 'Sam Broker',
  primaryContactPhone: '555-0200',
  primaryContactEmail: 'sam@mgcargo.test',
  status: 'ACTIVE',
  assignmentEligible: true,
  ineligibilityReasons: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  drivers: [],
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DriversTab carrier={CARRIER} />
      <ToastViewport />
    </QueryClientProvider>,
  );
}

describe('DriversTab — Add Driver failure handling (Task #5)', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
  });

  it('shows a toast error and keeps the modal open when the add request fails, and never shows success', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.post('/api/v1/carriers/carrier-1/drivers', () =>
        HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderTab();

    fireEvent.click(screen.getByText('+ Add Driver'));
    fireEvent.change(screen.getByLabelText(/^First Name/), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText(/^Last Name/), { target: { value: 'Doe' } });
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '555-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Driver' }));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Jane')).toBeInTheDocument();
    expect(screen.queryByText('Driver added.')).not.toBeInTheDocument();
  });
});
