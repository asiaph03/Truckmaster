import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { useSessionStore } from '../../../auth/session-store';
import { ToastViewport, useToastStore } from '../../../components/ui';
import { DriversTab } from './DriversTab';
import type { Carrier } from '../../../api';

function buildCarrier(overrides: Partial<Carrier> = {}): Carrier {
  return {
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
    ...overrides,
  };
}

const CARRIER = buildCarrier();

const ACTIVE_DRIVER = {
  id: 'driver-1',
  firstName: 'Julia',
  lastName: 'Rivera',
  phone: '555-0100',
  email: 'julia@carrier.test',
  licenseNumber: 'D123',
  active: true,
};

const INACTIVE_DRIVER = {
  id: 'driver-2',
  firstName: 'Sam',
  lastName: 'Okafor',
  phone: '555-0101',
  email: 'sam.okafor@carrier.test',
  licenseNumber: 'D456',
  active: false,
};

function renderTab(carrier: Carrier = CARRIER) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DriversTab carrier={carrier} />
      <ToastViewport />
    </QueryClientProvider>,
  );
}

describe('DriversTab — Add Driver failure handling (Task #5)', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
    useToastStore.setState({ toasts: [] });
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

  it('surfaces a duplicate-license conflict via toast, never silently', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.post('/api/v1/carriers/carrier-1/drivers', () =>
        HttpResponse.json(
          {
            error: {
              code: 'CONFLICT',
              message: 'A driver with this license number already exists for this carrier.',
            },
          },
          { status: 409 },
        ),
      ),
    );
    renderTab();

    fireEvent.click(screen.getByText('+ Add Driver'));
    fireEvent.change(screen.getByLabelText(/^First Name/), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText(/^Last Name/), { target: { value: 'Doe' } });
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '555-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Driver' }));

    await waitFor(() =>
      expect(
        screen.getByText('A driver with this license number already exists for this carrier.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('DriversTab — row actions (Task #7)', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
    useToastStore.setState({ toasts: [] });
  });

  it('shows Edit + Deactivate for an active driver and Edit + Reactivate for an inactive driver', () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    renderTab(buildCarrier({ drivers: [ACTIVE_DRIVER, INACTIVE_DRIVER] }));

    expect(screen.getAllByText('Edit')).toHaveLength(2);
    expect(screen.getByText('Deactivate')).toBeInTheDocument();
    expect(screen.getByText('Reactivate')).toBeInTheDocument();
  });

  it('does not render row actions without manageCarriers permission', () => {
    renderTab(buildCarrier({ drivers: [ACTIVE_DRIVER] }));

    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
  });

  it('pre-fills and submits the Edit modal, then shows success', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.patch('/api/v1/carriers/carrier-1/drivers/driver-1', () =>
        HttpResponse.json({ ...ACTIVE_DRIVER, phone: '555-9999' }),
      ),
    );
    renderTab(buildCarrier({ drivers: [ACTIVE_DRIVER] }));

    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByDisplayValue('Julia')).toBeInTheDocument();
    expect(screen.getByDisplayValue('555-0100')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '555-9999' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('Driver updated.')).toBeInTheDocument());
  });

  it('shows a toast error and keeps the Edit modal open when the update request fails', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.patch('/api/v1/carriers/carrier-1/drivers/driver-1', () =>
        HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderTab(buildCarrier({ drivers: [ACTIVE_DRIVER] }));

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('requires a reason to deactivate a driver, then succeeds once one is provided', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.post('/api/v1/carriers/carrier-1/drivers/driver-1/deactivate', () =>
        HttpResponse.json({ ...ACTIVE_DRIVER, active: false }),
      ),
    );
    renderTab(buildCarrier({ drivers: [ACTIVE_DRIVER] }));

    fireEvent.click(screen.getByText('Deactivate'));
    const dialog = screen.getByRole('dialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Deactivate Driver' });

    // No reason yet — confirm is a no-op (ConfirmDialog's requireReason guard).
    fireEvent.click(confirmButton);
    expect(screen.queryByText('Driver deactivated.')).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: 'No longer employed' },
    });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(screen.getByText('Driver deactivated.')).toBeInTheDocument());
  });

  it('requires a reason to reactivate a driver, then shows success', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.post('/api/v1/carriers/carrier-1/drivers/driver-2/reactivate', () =>
        HttpResponse.json({ ...INACTIVE_DRIVER, active: true }),
      ),
    );
    renderTab(buildCarrier({ drivers: [INACTIVE_DRIVER] }));

    fireEvent.click(screen.getByText('Reactivate'));
    const dialog = screen.getByRole('dialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Reactivate Driver' });

    fireEvent.click(confirmButton);
    expect(screen.queryByText('Driver reactivated.')).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: 'Rehired' } });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(screen.getByText('Driver reactivated.')).toBeInTheDocument());
  });

  it('shows a toast error and keeps the dialog open when deactivate fails', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.post('/api/v1/carriers/carrier-1/drivers/driver-1/deactivate', () =>
        HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderTab(buildCarrier({ drivers: [ACTIVE_DRIVER] }));

    fireEvent.click(screen.getByText('Deactivate'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: 'No longer employed' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate Driver' }));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
