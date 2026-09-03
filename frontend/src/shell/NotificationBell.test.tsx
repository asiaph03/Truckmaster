import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/mswServer';
import { NotificationBell } from './NotificationBell';
import type { AppNotification } from '../api';

function makeNotification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'notif-1',
    type: 'COMPLIANCE_EXPIRING_30_DAY',
    message: 'Cargo insurance for Nurana LLC expires 2026-09-24 (assignment eligible: Yes).',
    read: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderBell(notifications: AppNotification[], unreadCount: number) {
  server.use(
    http.get('/api/v1/notifications', () => HttpResponse.json(notifications)),
    http.get('/api/v1/notifications/unread-count', () => HttpResponse.json({ count: unreadCount })),
    http.post('/api/v1/notifications/:id/read', () => HttpResponse.json({ success: true })),
    http.post('/api/v1/notifications/mark-all-read', () => HttpResponse.json({ success: true })),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<NotificationBell />} />
          <Route path="/loads/:id" element={<div>Load Detail Page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openDropdown() {
  fireEvent.click(await screen.findByLabelText('Notifications'));
}

describe('NotificationBell — read/unread state (fixed read/isRead mismatch)', () => {
  it('renders a notification with read: false as unread (styled + counted)', async () => {
    renderBell([makeNotification({ id: 'n1', read: false })], 1);
    await openDropdown();

    const item = (await screen.findByText(/Cargo insurance/)).closest('.notification-bell-item');
    expect(item).toHaveClass('notification-bell-item-unread');
    expect(await screen.findByText('1')).toBeInTheDocument(); // badge count
  });

  it('renders a notification with read: true as read (no unread styling, not counted)', async () => {
    renderBell([makeNotification({ id: 'n1', read: true })], 0);
    await openDropdown();

    const item = (await screen.findByText(/Cargo insurance/)).closest('.notification-bell-item');
    expect(item).not.toHaveClass('notification-bell-item-unread');
    expect(screen.queryByText('Mark all as read')).not.toBeInTheDocument();
  });
});

describe('NotificationBell — badge count (decoupled from the paginated list)', () => {
  it('uses the authoritative /notifications/unread-count value, not a count derived from the 10-item list', async () => {
    // 3 notifications returned in the list, but the authoritative unread
    // count (as if more than 10 existed) is higher than what's visible.
    renderBell(
      [
        makeNotification({ id: 'n1', read: false }),
        makeNotification({ id: 'n2', read: false }),
        makeNotification({ id: 'n3', read: true }),
      ],
      27,
    );

    expect(await screen.findByText('27')).toBeInTheDocument();
  });

  it('shows no badge when the unread count is zero', async () => {
    const { container } = renderBell([makeNotification({ read: true })], 0);
    await openDropdown();

    await screen.findByText(/Cargo insurance/);
    expect(container.querySelector('.notification-bell-badge')).not.toBeInTheDocument();
  });
});

describe('NotificationBell — type-specific rendering', () => {
  it('renders CHECK_CALL_OVERDUE with a danger icon and both message lines', async () => {
    renderBell(
      [
        makeNotification({
          id: 'n1',
          type: 'CHECK_CALL_OVERDUE',
          message: 'Check call overdue — LOAD-000019\nDriver: Charles Jaynes · 18 min overdue',
        }),
      ],
      1,
    );
    await openDropdown();

    expect(await screen.findByText('Check call overdue — LOAD-000019')).toBeInTheDocument();
    expect(screen.getByText('Driver: Charles Jaynes · 18 min overdue')).toBeInTheDocument();
    const item = screen
      .getByText('Check call overdue — LOAD-000019')
      .closest('.notification-bell-item');
    expect(item?.querySelector('.notification-bell-icon-danger')).toBeInTheDocument();
  });

  it('renders LOAD_LATE with a danger icon', async () => {
    renderBell(
      [
        makeNotification({
          id: 'n1',
          type: 'LOAD_LATE',
          message: 'Load late — LOAD-000019\nDelivery appointment: 3:00 PM',
        }),
      ],
      1,
    );
    await openDropdown();

    const item = (await screen.findByText('Load late — LOAD-000019')).closest(
      '.notification-bell-item',
    );
    expect(item?.querySelector('.notification-bell-icon-danger')).toBeInTheDocument();
  });

  it('renders CHECK_CALL_DUE_SOON with a warning icon', async () => {
    renderBell(
      [
        makeNotification({
          id: 'n1',
          type: 'CHECK_CALL_DUE_SOON',
          message: 'Check call due — LOAD-000019\nDriver: Charles Jaynes · Due in 12 min',
        }),
      ],
      1,
    );
    await openDropdown();

    const item = (await screen.findByText('Check call due — LOAD-000019')).closest(
      '.notification-bell-item',
    );
    expect(item?.querySelector('.notification-bell-icon-warning')).toBeInTheDocument();
  });

  it('sorts CHECK_CALL_OVERDUE, then LOAD_LATE, then CHECK_CALL_DUE_SOON, then compliance notifications', async () => {
    renderBell(
      [
        makeNotification({ id: 'n1', type: 'COMPLIANCE_EXPIRING_30_DAY', message: 'Compliance A' }),
        makeNotification({ id: 'n2', type: 'CHECK_CALL_DUE_SOON', message: 'Due Soon B' }),
        makeNotification({ id: 'n3', type: 'LOAD_LATE', message: 'Late C' }),
        makeNotification({ id: 'n4', type: 'CHECK_CALL_OVERDUE', message: 'Overdue D' }),
      ],
      4,
    );
    await openDropdown();

    const items = await screen.findAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Overdue D',
      'Late C',
      'Due Soon B',
      'Compliance A',
    ]);
  });
});

describe('NotificationBell — compliance notification regression', () => {
  it('renders a compliance notification exactly as before — plain text, no icon, single line', async () => {
    renderBell([makeNotification({ id: 'n1', type: 'COMPLIANCE_EXPIRING_30_DAY' })], 1);
    await openDropdown();

    const item = (
      await screen.findByText(/Cargo insurance for Nurana LLC expires 2026-09-24/)
    ).closest('.notification-bell-item');
    expect(item?.querySelector('.notification-bell-icon')).not.toBeInTheDocument();
  });

  it('clicking an unread compliance notification marks it read and does not navigate', async () => {
    renderBell(
      [makeNotification({ id: 'n1', type: 'COMPLIANCE_EXPIRING_30_DAY', read: false })],
      1,
    );
    await openDropdown();

    fireEvent.click(await screen.findByText(/Cargo insurance/));

    await waitFor(() => {
      expect(screen.queryByText(/Cargo insurance/)).toBeInTheDocument();
    });
    expect(screen.queryByText('Load Detail Page')).not.toBeInTheDocument();
  });
});

describe('NotificationBell — click behavior (relatedEntityType === "Load")', () => {
  it('clicking a Load notification marks it read and navigates to the Load detail page', async () => {
    renderBell(
      [
        makeNotification({
          id: 'n1',
          type: 'CHECK_CALL_OVERDUE',
          message: 'Check call overdue — LOAD-000019\n18 min overdue',
          relatedEntityType: 'Load',
          relatedEntityId: 'load-19',
          read: false,
        }),
      ],
      1,
    );
    // Registered AFTER renderBell so it takes precedence over the generic
    // handler renderBell itself installs (MSW's server.use stacks —
    // later registrations win for overlapping routes).
    let markReadCalled = false;
    server.use(
      http.post('/api/v1/notifications/:id/read', () => {
        markReadCalled = true;
        return HttpResponse.json({ success: true });
      }),
    );
    await openDropdown();

    fireEvent.click(await screen.findByText('Check call overdue — LOAD-000019'));

    expect(await screen.findByText('Load Detail Page')).toBeInTheDocument();
    await waitFor(() => expect(markReadCalled).toBe(true));
  });

  it('clicking an already-read Load notification still navigates', async () => {
    renderBell(
      [
        makeNotification({
          id: 'n1',
          type: 'LOAD_LATE',
          message: 'Load late — LOAD-000019\nDelivery appointment: 3:00 PM',
          relatedEntityType: 'Load',
          relatedEntityId: 'load-19',
          read: true,
        }),
      ],
      0,
    );
    await openDropdown();

    fireEvent.click(await screen.findByText('Load late — LOAD-000019'));

    expect(await screen.findByText('Load Detail Page')).toBeInTheDocument();
  });
});
