import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { useSessionStore } from '../../../auth/session-store';
import { ToastViewport } from '../../../components/ui';
import { OverviewTab } from './OverviewTab';
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
  ineligibilityReasons: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  serviceAreas: [],
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OverviewTab carrier={CARRIER} />
      <ToastViewport />
    </QueryClientProvider>,
  );
}

describe('OverviewTab — Add Lane/Region failure handling (Task #5)', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
  });

  it('shows a toast error and keeps the modal open when the add request fails, and never shows success', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.post('/api/v1/carriers/carrier-1/service-areas', () =>
        HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderTab();

    fireEvent.click(screen.getByText('+ Add'));
    fireEvent.change(screen.getByLabelText(/^Origin City/), { target: { value: 'Dallas' } });
    fireEvent.change(screen.getByLabelText(/^Origin State/), { target: { value: 'TX' } });
    fireEvent.change(screen.getByLabelText(/^Destination City/), { target: { value: 'Atlanta' } });
    fireEvent.change(screen.getByLabelText(/^Destination State/), { target: { value: 'GA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Dallas')).toBeInTheDocument();
    expect(screen.queryByText('Service area added.')).not.toBeInTheDocument();
  });
});
