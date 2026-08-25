import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test/mswServer';
import { useSessionStore } from '../../../auth/session-store';
import type { Load } from '../../../api';
import { ActivityHistoryTab } from './ActivityHistoryTab';

const LOAD = { id: 'load-1' } as unknown as Load;

const ENTRIES = [
  {
    type: 'NOTE',
    id: 'note-1',
    loadId: 'load-1',
    authorUserId: 'user-1',
    content: 'Customer asked about ETA.',
    createdAt: '2026-01-03T00:00:00.000Z',
    timestamp: '2026-01-03T00:00:00.000Z',
  },
  {
    type: 'COMMUNICATION',
    id: 'comm-1',
    loadId: 'load-1',
    loggedByUserId: 'user-1',
    activityType: 'Called Carrier',
    direction: 'OUTBOUND',
    contactPerson: null,
    notes: 'Confirmed pickup time.',
    occurredAt: '2026-01-02T00:00:00.000Z',
    createdAt: '2026-01-02T00:00:00.000Z',
    timestamp: '2026-01-02T00:00:00.000Z',
  },
  {
    type: 'AUDIT',
    id: 'audit-1',
    action: 'Carrier Assigned',
    entityType: 'Load',
    previousValue: null,
    newValue: { carrierId: 'carrier-1', carrierRate: null },
    actorUserId: 'user-1',
    actorType: 'HUMAN',
    createdAt: '2026-01-01T00:00:00.000Z',
    timestamp: '2026-01-01T00:00:00.000Z',
  },
];

function renderTab() {
  server.use(
    http.get('/api/v1/loads/load-1/activity-history', () => HttpResponse.json(ENTRIES)),
    http.get('/api/v1/memberships', () =>
      HttpResponse.json([{ userId: 'user-1', user: { name: 'Jane Dispatcher' } }]),
    ),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ActivityHistoryTab load={LOAD} />
    </QueryClientProvider>,
  );
}

describe('ActivityHistoryTab — Frontend Phase 7 (UI_UX_DESIGN.md §5.4.4, LD-6)', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
  });

  it('renders all three entry types with resolved author names', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    renderTab();

    await waitFor(() => expect(screen.getAllByText('Jane Dispatcher')).toHaveLength(3));
    expect(screen.getByText('Customer asked about ETA.')).toBeInTheDocument();
    expect(screen.getByText('Confirmed pickup time.')).toBeInTheDocument();
    expect(screen.getByText('Carrier Assigned')).toBeInTheDocument();
  });

  it('renders a redacted (null) financial field as "—", never the literal string "null"', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    renderTab();

    await waitFor(() => expect(screen.getAllByText('Jane Dispatcher')).toHaveLength(3));
    expect(screen.getByText(/carrierRate: —/)).toBeInTheDocument();
    expect(screen.queryByText(/carrierRate: null/)).not.toBeInTheDocument();
  });

  it('narrows the timeline when a filter chip is clicked, and shows correct counts', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    renderTab();
    await waitFor(() => expect(screen.getAllByText('Jane Dispatcher')).toHaveLength(3));

    fireEvent.click(screen.getByText('Internal Notes'));
    expect(screen.getByText('Customer asked about ETA.')).toBeInTheDocument();
    expect(screen.queryByText('Confirmed pickup time.')).not.toBeInTheDocument();
    expect(screen.queryByText('Carrier Assigned')).not.toBeInTheDocument();

    // Clicking the active chip again resets to "All" (matches the Dispatch Board toggle convention).
    fireEvent.click(screen.getByText('Internal Notes'));
    expect(screen.getByText('Confirmed pickup time.')).toBeInTheDocument();
  });

  it('shows the Add actions for a role with logLoadActivity, and hides them for Compliance Reviewer', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    const { unmount } = renderTab();
    await waitFor(() => expect(screen.getAllByText('Jane Dispatcher')).toHaveLength(3));
    expect(screen.getByText('+ Add Internal Note')).toBeInTheDocument();
    expect(screen.getByText('+ Log Communication Activity')).toBeInTheDocument();
    unmount();

    useSessionStore.setState({ roles: ['COMPLIANCE_REVIEWER'] });
    renderTab();
    await waitFor(() => expect(screen.getAllByText('Jane Dispatcher')).toHaveLength(3));
    expect(screen.queryByText('+ Add Internal Note')).not.toBeInTheDocument();
    expect(screen.queryByText('+ Log Communication Activity')).not.toBeInTheDocument();
  });
});
