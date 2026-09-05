import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { ToastViewport } from '../../components/ui';
import { LoadDetailPage } from './LoadDetailPage';
import type { Load } from '../../api';

const CUSTOMER = { id: 'cust-1', legalName: 'Acme Freight' };

function makeLoad(overrides: Partial<Load> = {}): Load {
  return {
    id: 'load-1',
    loadNumber: 'LOAD-000001',
    customerId: 'cust-1',
    bookingSource: 'DIRECT',
    status: 'BOOKED',
    equipmentType: 'DRY_VAN',
    customerRate: '1000',
    rateSource: 'MANUAL',
    rateAgreementId: null,
    podStatus: 'NOT_RECEIVED',
    riskStatus: 'NORMAL',
    invoiced: false,
    createdByUserId: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    stops: [],
    sourcingAttempts: [],
    dispatchRecord: null,
    checkCalls: [],
    chargeLineItems: [],
    ...overrides,
  };
}

function renderPage(load: Load) {
  server.use(
    http.get('/api/v1/loads/:id', () => HttpResponse.json(load)),
    http.get('/api/v1/customers/:id', () => HttpResponse.json(CUSTOMER)),
    http.get('/api/v1/memberships', () => HttpResponse.json([])),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/loads/${load.id}`]}>
        <Routes>
          <Route path="/loads/:id" element={<LoadDetailPage />} />
        </Routes>
      </MemoryRouter>
      <ToastViewport />
    </QueryClientProvider>,
  );
}

describe('LoadDetailPage — Cancel Load workflow', () => {
  beforeEach(() => {
    useSessionStore.setState({ roles: ['ADMIN'] });
  });

  it.each(['BOOKED', 'CARRIER_SOURCING', 'CARRIER_ASSIGNED', 'RATE_CONFIRMATION'] as const)(
    'shows the Cancel Load button for a %s Load',
    async (status) => {
      renderPage(makeLoad({ status }));
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'LOAD-000001' })).toBeInTheDocument(),
      );

      expect(screen.getByText('Cancel Load')).toBeInTheDocument();
    },
  );

  it.each(['DISPATCHED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const)(
    'hides the Cancel Load button for a %s Load',
    async (status) => {
      renderPage(makeLoad({ status }));
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'LOAD-000001' })).toBeInTheDocument(),
      );

      expect(screen.queryByText('Cancel Load')).not.toBeInTheDocument();
    },
  );

  it('hides every header action, including Cancel Load, when the permission gate denies sourceAndDispatchLoads', async () => {
    useSessionStore.setState({ roles: ['SALES_BOOKING'] });
    renderPage(makeLoad({ status: 'BOOKED' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'LOAD-000001' })).toBeInTheDocument(),
    );

    expect(screen.queryByText('Cancel Load')).not.toBeInTheDocument();
  });

  it('clicking Cancel Load opens a confirmation dialog requiring a reason, with Cancel Load / Keep Load buttons', async () => {
    let cancelCalled = false;
    server.use(
      http.post('/api/v1/loads/:id/cancel', () => {
        cancelCalled = true;
        return HttpResponse.json(makeLoad({ status: 'CANCELLED' }));
      }),
    );
    renderPage(makeLoad({ status: 'BOOKED' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'LOAD-000001' })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText('Cancel Load'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Cancel Load?')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Reason/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Keep Load' })).toBeInTheDocument();

    // Confirming with no reason entered must be a no-op — requireReason
    // gates the confirm action itself, not a disabled attribute on the button.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel Load' }));
    expect(cancelCalled).toBe(false);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('canceling the dialog (Keep Load) closes it and never calls the cancel endpoint', async () => {
    let cancelCalled = false;
    server.use(
      http.post('/api/v1/loads/:id/cancel', () => {
        cancelCalled = true;
        return HttpResponse.json(makeLoad({ status: 'CANCELLED' }));
      }),
    );
    renderPage(makeLoad({ status: 'BOOKED' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'LOAD-000001' })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText('Cancel Load'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Load' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(cancelCalled).toBe(false);
  });

  it('confirming with a reason calls POST /loads/:id/cancel with that reason, then toasts and refetches to reflect CANCELLED', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    // Mutable so the GET (refetch, after the mutation) reflects the same
    // state change the POST handler just made — a fixed/static GET mock
    // would silently keep serving the pre-cancel BOOKED snapshot forever.
    let currentLoad = makeLoad({ status: 'BOOKED' });
    server.use(
      http.get('/api/v1/loads/:id', () => HttpResponse.json(currentLoad)),
      http.get('/api/v1/customers/:id', () => HttpResponse.json(CUSTOMER)),
      http.get('/api/v1/memberships', () => HttpResponse.json([])),
      http.post('/api/v1/loads/:id/cancel', async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        currentLoad = { ...currentLoad, status: 'CANCELLED' };
        return HttpResponse.json(currentLoad);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/loads/load-1']}>
          <Routes>
            <Route path="/loads/:id" element={<LoadDetailPage />} />
          </Routes>
        </MemoryRouter>
        <ToastViewport />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'LOAD-000001' })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText('Cancel Load'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: 'Customer cancelled the order.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel Load' }));

    await waitFor(() => expect(receivedBody).toEqual({ reason: 'Customer cancelled the order.' }));
    expect(await screen.findByText('Load cancelled.')).toBeInTheDocument();
    // Cancel Load action disappears once the refetched Load shows CANCELLED —
    // proving the UI reflects the new status immediately, not just the toast.
    await waitFor(() => expect(screen.queryByText('Cancel Load')).not.toBeInTheDocument());
  });

  it('a business-rule failure shows the existing error toast pattern and leaves the dialog open', async () => {
    server.use(
      http.post('/api/v1/loads/:id/cancel', () =>
        HttpResponse.json(
          {
            error: {
              code: 'INVALID_TRANSITION',
              message:
                'This Load can no longer be cancelled — it has already been dispatched or completed.',
            },
          },
          { status: 409 },
        ),
      ),
    );
    renderPage(makeLoad({ status: 'BOOKED' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'LOAD-000001' })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText('Cancel Load'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: 'Customer cancelled the order.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel Load' }));

    expect(
      await screen.findByText(
        'This Load can no longer be cancelled — it has already been dispatched or completed.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('LoadDetailPage — initial load failure recovery (Task #4)', () => {
  it('shows an error state (not stuck Loading) when the initial GET fails, and Retry recovers it', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let callCount = 0;
    // Registered before render() — never relies on a post-render server.use()
    // override, which can lose the race against a query's own initial fetch.
    server.use(
      http.get('/api/v1/loads/:id', () => {
        callCount += 1;
        if (callCount === 1) {
          return HttpResponse.json(
            { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
            { status: 500 },
          );
        }
        return HttpResponse.json(makeLoad({}));
      }),
      http.get('/api/v1/customers/:id', () => HttpResponse.json(CUSTOMER)),
      http.get('/api/v1/memberships', () => HttpResponse.json([])),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/loads/load-1']}>
          <Routes>
            <Route path="/loads/:id" element={<LoadDetailPage />} />
          </Routes>
        </MemoryRouter>
        <ToastViewport />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText("Couldn't load this load. Please try again.")).toBeInTheDocument(),
    );
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'LOAD-000001' })).toBeInTheDocument(),
    );
    expect(callCount).toBe(2);
  });
});
