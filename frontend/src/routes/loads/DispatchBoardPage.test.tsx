import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { DispatchBoardPage } from './DispatchBoardPage';

function load(overrides: Record<string, unknown> = {}) {
  return {
    id: 'load-1',
    loadNumber: 'LOAD-000001',
    customerId: 'customer-1',
    status: 'BOOKED',
    equipmentType: 'DRY_VAN',
    customerRate: '1800.00',
    carrierRate: null,
    riskStatus: 'NORMAL',
    assignedCarrierId: undefined,
    assignedDispatcherId: undefined,
    assignedDriverName: null,
    stops: [
      { id: 's1', sequence: 1, stopType: 'PICKUP', city: 'Dallas', state: 'TX', status: 'PENDING' },
      {
        id: 's2',
        sequence: 2,
        stopType: 'DELIVERY',
        city: 'Chicago',
        state: 'IL',
        status: 'PENDING',
      },
    ],
    ...overrides,
  };
}

const CUSTOMER = { id: 'customer-1', legalName: 'Acme Freight' };
const CARRIER = { id: 'carrier-1', legalName: 'Best Carrier', assignmentEligible: true };

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DispatchBoardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * The bulk Assign Carrier modal's `SearchableCombobox` only renders its
 * option panel once its text input is focused, and the plain carrier
 * legal name text ("Best Carrier") is ambiguous with the always-present
 * toolbar carrier-filter `<select>` option — so this focuses the
 * combobox input specifically (its placeholder, "Search…", is unique to
 * it) and matches on the combobox's own richer option label, which
 * includes the eligibility suffix the filter dropdown's option doesn't.
 */
function selectCarrierInCombobox() {
  fireEvent.focus(screen.getByPlaceholderText('Search…'));
  fireEvent.click(screen.getByText(`${CARRIER.legalName} (Eligible)`));
}

function mockBaseHandlers(loads: unknown[]) {
  server.use(
    http.get('/api/v1/loads', () => HttpResponse.json(loads)),
    http.get('/api/v1/customers', () => HttpResponse.json([CUSTOMER])),
    http.get('/api/v1/carriers', () => HttpResponse.json([CARRIER])),
    http.get('/api/v1/memberships', () => HttpResponse.json([])),
  );
}

describe('DispatchBoardPage — Frontend Phase 18 (bulk Export + bulk Assign Carrier)', () => {
  beforeEach(() => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
  });

  it('Assign Carrier bulk action assigns the same carrier/rate to every selected Load and reports success for each', async () => {
    mockBaseHandlers([load({ id: 'load-1' }), load({ id: 'load-2', loadNumber: 'LOAD-000002' })]);
    const assignedTo: string[] = [];
    server.use(
      http.post('/api/v1/loads/:id/assign-carrier', ({ params }) => {
        assignedTo.push(params.id as string);
        return HttpResponse.json(load({ id: params.id, assignedCarrierId: CARRIER.id }));
      }),
    );

    renderPage();
    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());

    const checkboxes = screen.getAllByLabelText('Select row');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    fireEvent.click(screen.getByText('Assign Carrier'));
    selectCarrierInCombobox();
    // FormField renders the required marker inside the <label> itself
    // (accessible name "Carrier Rate*"), so an exact-match query misses —
    // matches every other required-field query in this codebase's tests.
    fireEvent.change(screen.getByLabelText(/Carrier Rate/), { target: { value: '1500' } });
    fireEvent.click(screen.getByText('Assign'));

    await waitFor(() => expect(assignedTo.sort()).toEqual(['load-1', 'load-2']));
    await waitFor(() => expect(screen.getAllByText('Assigned')).toHaveLength(2));
  });

  it('reports mixed success/failure per load, with the specific eligibility reason for the failed load', async () => {
    mockBaseHandlers([load({ id: 'load-1' }), load({ id: 'load-2', loadNumber: 'LOAD-000002' })]);
    server.use(
      http.post('/api/v1/loads/:id/assign-carrier', ({ params }) => {
        if (params.id === 'load-2') {
          return HttpResponse.json(
            {
              error: {
                code: 'ELIGIBILITY_ERROR',
                message: 'Carrier is not eligible.',
                details: { reasons: ['Not authorized for this lane'] },
              },
            },
            { status: 409 },
          );
        }
        return HttpResponse.json(load({ id: params.id, assignedCarrierId: CARRIER.id }));
      }),
    );

    renderPage();
    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());

    const checkboxes = screen.getAllByLabelText('Select row');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByText('Assign Carrier'));
    selectCarrierInCombobox();
    fireEvent.change(screen.getByLabelText(/Carrier Rate/), { target: { value: '1500' } });
    fireEvent.click(screen.getByText('Assign'));

    await waitFor(() => expect(screen.getByText('Assigned')).toBeInTheDocument());
    expect(screen.getByText(/Failed: Not authorized for this lane/)).toBeInTheDocument();
  });

  it('Export Selected sends only the selected Load ids', async () => {
    mockBaseHandlers([load({ id: 'load-1' }), load({ id: 'load-2', loadNumber: 'LOAD-000002' })]);
    let exportUrl: string | undefined;
    server.use(
      http.get('/api/v1/loads/search/export', ({ request }) => {
        exportUrl = request.url;
        return new HttpResponse('Load #\r\nLOAD-000001', {
          headers: { 'Content-Type': 'text/csv' },
        });
      }),
    );
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderPage();
    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());

    fireEvent.click(screen.getAllByLabelText('Select row')[0]);
    fireEvent.click(screen.getByText('Export Selected'));

    await waitFor(() => expect(exportUrl).toBeDefined());
    const params = new URL(exportUrl!).searchParams;
    expect(params.getAll('ids')).toEqual(['load-1']);
    clickSpy.mockRestore();
  });

  it('the page-level Export sends excludeClosed=true in the default "All (excl. Closed)" state', async () => {
    mockBaseHandlers([load({ id: 'load-1' })]);
    let exportUrl: string | undefined;
    server.use(
      http.get('/api/v1/loads/search/export', ({ request }) => {
        exportUrl = request.url;
        return new HttpResponse('Load #\r\nLOAD-000001', {
          headers: { 'Content-Type': 'text/csv' },
        });
      }),
    );
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderPage();
    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Export'));

    await waitFor(() => expect(exportUrl).toBeDefined());
    const params = new URL(exportUrl!).searchParams;
    expect(params.get('excludeClosed')).toBe('true');
    expect(params.has('status')).toBe(false);
    clickSpy.mockRestore();
  });

  it('an explicit Status filter is sent as-is, without excludeClosed', async () => {
    // Kept at the default BOOKED status: the mock GET /loads handler
    // ignores query params entirely (like LoadSearchPage.test.tsx's
    // equivalent mocks), and Table View's own client-side default-exclude
    // only fires when `status` is empty — a CLOSED fixture row would never
    // render at all once the dropdown is changed away from the default.
    // This test asserts the outgoing export request, not server-side
    // filtering behavior.
    mockBaseHandlers([load({ id: 'load-1' })]);
    let exportUrl: string | undefined;
    server.use(
      http.get('/api/v1/loads/search/export', ({ request }) => {
        exportUrl = request.url;
        return new HttpResponse('Load #\r\nLOAD-000001', {
          headers: { 'Content-Type': 'text/csv' },
        });
      }),
    );
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderPage();
    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('All (excl. Closed)'), {
      target: { value: 'CLOSED' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(exportUrl).toBeDefined());
    const params = new URL(exportUrl!).searchParams;
    expect(params.get('status')).toBe('CLOSED');
    expect(params.has('excludeClosed')).toBe(false);
    clickSpy.mockRestore();
  });

  it('disables page-level Export while the "Overdue" or "Today" quick filter is active', async () => {
    mockBaseHandlers([load({ id: 'load-1' })]);

    renderPage();
    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());

    const exportButton = () => screen.getByRole('button', { name: 'Export' });
    expect(exportButton()).not.toBeDisabled();

    fireEvent.click(screen.getByText('Overdue'));
    expect(exportButton()).toBeDisabled();
    expect(
      screen.getByText(/Export isn't available while "Overdue" is active/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText('Overdue'));
    fireEvent.click(screen.getByText('Today'));
    expect(exportButton()).toBeDisabled();

    fireEvent.click(screen.getByText('Today'));
    expect(exportButton()).not.toBeDisabled();
  });

  it('maps the "Pickups next 4h" quick filter onto pickupFrom/pickupTo for export', async () => {
    mockBaseHandlers([load({ id: 'load-1' })]);
    let exportUrl: string | undefined;
    server.use(
      http.get('/api/v1/loads/search/export', ({ request }) => {
        exportUrl = request.url;
        return new HttpResponse('Load #\r\nLOAD-000001', {
          headers: { 'Content-Type': 'text/csv' },
        });
      }),
    );
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderPage();
    await waitFor(() => expect(screen.getByText('LOAD-000001')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Pickups next 4h'));
    fireEvent.click(screen.getByText('Export'));

    await waitFor(() => expect(exportUrl).toBeDefined());
    const params = new URL(exportUrl!).searchParams;
    expect(params.has('pickupFrom')).toBe(true);
    expect(params.has('pickupTo')).toBe(true);
    clickSpy.mockRestore();
  });
});

describe('DispatchBoardPage — Dispatch Board Driver visibility', () => {
  beforeEach(() => {
    useSessionStore.setState({ roles: ['ADMIN'] });
  });

  const JOHN = load({
    id: 'load-john',
    loadNumber: 'LOAD-000010',
    assignedDriverName: 'John Smith',
  });
  const JANE = load({
    id: 'load-jane',
    loadNumber: 'LOAD-000020',
    assignedDriverName: 'Jane Doe',
  });
  const UNASSIGNED = load({
    id: 'load-unassigned',
    loadNumber: 'LOAD-000030',
    assignedDriverName: null,
  });

  describe('search', () => {
    it('still matches by Load #', async () => {
      mockBaseHandlers([JOHN, JANE]);
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000010')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Search Load #, Customer, or Driver…'), {
        target: { value: 'LOAD-000010' },
      });

      expect(screen.getByText('LOAD-000010')).toBeInTheDocument();
      expect(screen.queryByText('LOAD-000020')).not.toBeInTheDocument();
    });

    it('still matches by Customer', async () => {
      mockBaseHandlers([JOHN, JANE]);
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000010')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Search Load #, Customer, or Driver…'), {
        target: { value: 'acme' },
      });

      // Both fixtures share the same mocked customer, so both still match.
      expect(screen.getByText('LOAD-000010')).toBeInTheDocument();
      expect(screen.getByText('LOAD-000020')).toBeInTheDocument();
    });

    it('matches driver full name', async () => {
      mockBaseHandlers([JOHN, JANE]);
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000010')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Search Load #, Customer, or Driver…'), {
        target: { value: 'John Smith' },
      });

      expect(screen.getByText('LOAD-000010')).toBeInTheDocument();
      expect(screen.queryByText('LOAD-000020')).not.toBeInTheDocument();
    });

    it('matches driver first name only', async () => {
      mockBaseHandlers([JOHN, JANE]);
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000010')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Search Load #, Customer, or Driver…'), {
        target: { value: 'John' },
      });

      expect(screen.getByText('LOAD-000010')).toBeInTheDocument();
      expect(screen.queryByText('LOAD-000020')).not.toBeInTheDocument();
    });

    it('matches driver last name only', async () => {
      mockBaseHandlers([JOHN, JANE]);
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000010')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Search Load #, Customer, or Driver…'), {
        target: { value: 'Smith' },
      });

      expect(screen.getByText('LOAD-000010')).toBeInTheDocument();
      expect(screen.queryByText('LOAD-000020')).not.toBeInTheDocument();
    });

    it('matches a partial, case-insensitive driver name substring', async () => {
      mockBaseHandlers([JOHN, JANE]);
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000010')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Search Load #, Customer, or Driver…'), {
        target: { value: 'HN SM' }, // spans "Jo[hn s]mith", upper case vs "John Smith"
      });

      expect(screen.getByText('LOAD-000010')).toBeInTheDocument();
      expect(screen.queryByText('LOAD-000020')).not.toBeInTheDocument();
    });

    it('a Load with no assigned driver never breaks search and is simply excluded from a driver-name query', async () => {
      mockBaseHandlers([JOHN, UNASSIGNED]);
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000010')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Search Load #, Customer, or Driver…'), {
        target: { value: 'John' },
      });
      expect(screen.getByText('LOAD-000010')).toBeInTheDocument();
      expect(screen.queryByText('LOAD-000030')).not.toBeInTheDocument();

      // Clearing the search still renders the unassigned load normally.
      fireEvent.change(screen.getByPlaceholderText('Search Load #, Customer, or Driver…'), {
        target: { value: '' },
      });
      expect(screen.getByText('LOAD-000030')).toBeInTheDocument();
    });
  });

  describe('table view', () => {
    it('shows the assigned driver name in the Driver column', async () => {
      mockBaseHandlers([JOHN]);
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000010')).toBeInTheDocument());

      expect(screen.getByText('John Smith')).toBeInTheDocument();
    });

    it('shows "Unassigned" in the Driver column when no driver is assigned (distinct from the Dispatcher column, which is also unassigned)', async () => {
      // A membership is mocked and assigned as dispatcher so the
      // Dispatcher column shows a real name here, not its own
      // "Unassigned" fallback — isolating the assertion to the Driver
      // column specifically rather than an ambiguous page-wide match.
      const MEMBERSHIP = { userId: 'user-1', user: { name: 'Jane Dispatcher' } };
      server.use(
        http.get('/api/v1/loads', () =>
          HttpResponse.json([{ ...UNASSIGNED, assignedDispatcherId: 'user-1' }]),
        ),
        http.get('/api/v1/customers', () => HttpResponse.json([CUSTOMER])),
        http.get('/api/v1/carriers', () => HttpResponse.json([CARRIER])),
        http.get('/api/v1/memberships', () => HttpResponse.json([MEMBERSHIP])),
      );
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000030')).toBeInTheDocument());

      const row = screen.getByText('LOAD-000030').closest('tr') as HTMLElement;
      const cellTexts = Array.from(row.querySelectorAll('td')).map((td) => td.textContent);
      expect(cellTexts).toContain('Unassigned'); // Driver
      expect(cellTexts).toContain('Jane Dispatcher'); // Dispatcher, distinctly resolved
    });
  });

  describe('kanban view', () => {
    it('shows the assigned driver name on the card', async () => {
      mockBaseHandlers([JOHN]);
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000010')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Kanban'));

      await waitFor(() => expect(screen.getByText('Driver: John Smith')).toBeInTheDocument());
    });

    it('shows "Unassigned" on the card when no driver is assigned', async () => {
      mockBaseHandlers([UNASSIGNED]);
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000030')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Kanban'));

      await waitFor(() => expect(screen.getByText('Driver: Unassigned')).toBeInTheDocument());
    });
  });

  describe('calendar view', () => {
    const scheduledLoad = load({
      id: 'load-scheduled',
      loadNumber: 'LOAD-000040',
      assignedDriverName: 'John Smith',
      stops: [
        {
          id: 's1',
          sequence: 1,
          stopType: 'PICKUP',
          city: 'Dallas',
          state: 'TX',
          status: 'PENDING',
          appointmentDatetime: new Date().toISOString(),
        },
      ],
    });
    const scheduledUnassigned = load({
      id: 'load-scheduled-unassigned',
      loadNumber: 'LOAD-000050',
      assignedDriverName: null,
      stops: [
        {
          id: 's1',
          sequence: 1,
          stopType: 'PICKUP',
          city: 'Bedford Park',
          state: 'IL',
          status: 'PENDING',
          appointmentDatetime: new Date().toISOString(),
        },
      ],
    });

    it('shows the assigned driver name on the event', async () => {
      mockBaseHandlers([scheduledLoad]);
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000040')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));

      await waitFor(() => expect(screen.getAllByText('LOAD-000040').length).toBeGreaterThan(0));
      expect(screen.getByText('John Smith')).toBeInTheDocument();
    });

    it('shows "Unassigned" on the event when no driver is assigned (distinct from the carrier "Unassigned" badge on the same card)', async () => {
      mockBaseHandlers([scheduledUnassigned]);
      renderPage();
      fireEvent.click(screen.getByText('Calendar'));

      await waitFor(() => expect(screen.getByText('LOAD-000050')).toBeInTheDocument());
      const eventCard = screen.getByText('LOAD-000050').closest('.calendar-event') as HTMLElement;
      expect(eventCard).not.toBeNull();
      const driverLine = eventCard.querySelector('.calendar-event-driver');
      expect(driverLine?.textContent).toBe('Unassigned');
    });
  });

  describe('filter combination', () => {
    it('driver search narrows results while a quick filter is simultaneously active', async () => {
      const todayJohn = load({
        id: 'load-today-john',
        loadNumber: 'LOAD-000060',
        assignedDriverName: 'John Smith',
        stops: [
          {
            id: 's1',
            sequence: 1,
            stopType: 'PICKUP',
            stopPurpose: 'STANDARD',
            city: 'Dallas',
            state: 'TX',
            status: 'PENDING',
            appointmentDatetime: new Date().toISOString(),
          },
        ],
      });
      const todayJane = load({
        id: 'load-today-jane',
        loadNumber: 'LOAD-000070',
        assignedDriverName: 'Jane Doe',
        stops: [
          {
            id: 's1',
            sequence: 1,
            stopType: 'PICKUP',
            stopPurpose: 'STANDARD',
            city: 'Dallas',
            state: 'TX',
            status: 'PENDING',
            appointmentDatetime: new Date().toISOString(),
          },
        ],
      });
      mockBaseHandlers([todayJohn, todayJane]);
      renderPage();
      await waitFor(() => expect(screen.getByText('LOAD-000060')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Today'));
      // Both loads have a today pickup, so the quick filter alone keeps both.
      expect(screen.getByText('LOAD-000060')).toBeInTheDocument();
      expect(screen.getByText('LOAD-000070')).toBeInTheDocument();

      fireEvent.change(screen.getByPlaceholderText('Search Load #, Customer, or Driver…'), {
        target: { value: 'John' },
      });

      // The quick filter and the driver search both remain in effect together.
      expect(screen.getByText('LOAD-000060')).toBeInTheDocument();
      expect(screen.queryByText('LOAD-000070')).not.toBeInTheDocument();
    });
  });
});
