import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { NeedsAttentionList } from './NeedsAttentionList';

function renderList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NeedsAttentionList />
    </QueryClientProvider>,
  );
}

const NOTIFICATION_ITEM = {
  id: 'notif-1',
  source: 'NOTIFICATION',
  type: 'CHECK_CALL_OVERDUE',
  severity: 'HIGH',
  status: null,
  title: null,
  message: 'Check call overdue',
  reason: null,
  impact: null,
  suggestedActions: null,
  metadata: null,
  loadId: 'load-1',
  loadNumber: 'LOAD-000001',
  createdAt: '2026-09-26T10:00:00Z',
  detectedAt: null,
  updatedAt: null,
  resolvedAt: null,
};

const ATTENTION_ITEM = {
  id: 'attn-1',
  source: 'ATTENTION_ITEM',
  type: 'STALE_LOCATION',
  severity: 'HIGH',
  status: 'ACTIVE',
  title: 'Stale Location',
  message: null,
  reason: 'Location has not been updated in approximately 3h 5m.',
  impact: null,
  suggestedActions: [{ type: 'VIEW_LOAD' }],
  metadata: { ageMinutes: 185 },
  loadId: 'load-2',
  loadNumber: 'LOAD-000002',
  createdAt: null,
  detectedAt: '2026-09-27T08:00:00Z',
  updatedAt: '2026-09-27T08:00:00Z',
  resolvedAt: null,
};

describe('NeedsAttentionList — B.5 combined Notification + AttentionItem panel', () => {
  it('renders a legacy Notification item linking to its Load', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({ items: [NOTIFICATION_ITEM], total: 1, page: 1, pageSize: 25 }),
      ),
    );

    renderList();

    expect(await screen.findByText('LOAD-000001')).toBeInTheDocument();
    expect(screen.getByText('LOAD-000001').closest('a')).toHaveAttribute('href', '/loads/load-1');
    expect(screen.getByText('Check call overdue')).toBeInTheDocument();
  });

  it('renders an AttentionItem with its title, reason, and severity', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({ items: [ATTENTION_ITEM], total: 1, page: 1, pageSize: 25 }),
      ),
    );

    renderList();

    expect(await screen.findByText('LOAD-000002')).toBeInTheDocument();
    expect(screen.getByText('Stale Location')).toBeInTheDocument();
    expect(
      screen.getByText('Location has not been updated in approximately 3h 5m.'),
    ).toBeInTheDocument();
  });

  it('shows a distinct severity badge for each tier', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({
          items: [
            { ...ATTENTION_ITEM, id: 'a-critical', severity: 'CRITICAL' },
            { ...ATTENTION_ITEM, id: 'a-medium', severity: 'MEDIUM' },
          ],
          total: 2,
          page: 1,
          pageSize: 25,
        }),
      ),
    );

    renderList();

    expect(await screen.findByText('CRITICAL')).toBeInTheDocument();
    expect(screen.getByText('MEDIUM')).toBeInTheDocument();
  });

  it('links each item to its own Load detail page', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({
          items: [NOTIFICATION_ITEM, ATTENTION_ITEM],
          total: 2,
          page: 1,
          pageSize: 25,
        }),
      ),
    );

    renderList();

    expect(await screen.findByText('LOAD-000001')).toHaveAttribute('href', '/loads/load-1');
    expect(screen.getByText('LOAD-000002')).toHaveAttribute('href', '/loads/load-2');
  });

  it('renders a mixed Notification + AttentionItem list together', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({
          items: [NOTIFICATION_ITEM, ATTENTION_ITEM],
          total: 2,
          page: 1,
          pageSize: 25,
        }),
      ),
    );

    renderList();

    expect(await screen.findByText('Check call overdue')).toBeInTheDocument();
    expect(screen.getByText('Stale Location')).toBeInTheDocument();
  });

  it('shows a genuine empty state — never fake placeholder items — when nothing needs attention', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 25 }),
      ),
    );

    renderList();

    expect(await screen.findByText('Nothing needs attention right now.')).toBeInTheDocument();
  });

  it('shows the shared error state with a working Retry', async () => {
    let attempts = 0;
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () => {
        attempts += 1;
        if (attempts === 1) return HttpResponse.json(null, { status: 500 });
        return HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 25 });
      }),
    );

    renderList();

    expect(
      await screen.findByText("Couldn't load Needs Attention Today. Please try again."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(screen.getByText('Nothing needs attention right now.')).toBeInTheDocument(),
    );
    expect(attempts).toBe(2);
  });

  it('shows pagination controls and advances to the next page', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', ({ request }) => {
        const url = new URL(request.url);
        const page = url.searchParams.get('page') ?? '1';
        if (page === '2') {
          return HttpResponse.json({
            items: [{ ...ATTENTION_ITEM, id: 'attn-page-2' }],
            total: 30,
            page: 2,
            pageSize: 25,
          });
        }
        return HttpResponse.json({ items: [NOTIFICATION_ITEM], total: 30, page: 1, pageSize: 25 });
      }),
    );

    renderList();

    expect(await screen.findByText('1 / 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(screen.getByText('2 / 2')).toBeInTheDocument());
    expect(await screen.findByText('LOAD-000002')).toBeInTheDocument();
  });
});
