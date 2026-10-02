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

const MISSING_POD_ITEM = {
  id: 'attn-pod-1',
  source: 'ATTENTION_ITEM',
  type: 'MISSING_POD',
  severity: 'HIGH',
  status: 'ACTIVE',
  title: 'Missing POD',
  message: null,
  reason: "No POD document has been uploaded 29d 12h after this Load's delivery.",
  impact: null,
  suggestedActions: [{ type: 'VIEW_LOAD' }],
  metadata: { ageHours: 708, clockBasis: 'deliveredAuditEntry', loadStatus: 'DELIVERED' },
  loadId: 'load-3',
  loadNumber: 'LOAD-000003',
  createdAt: null,
  detectedAt: '2026-10-01T07:00:00Z',
  updatedAt: '2026-10-01T07:00:00Z',
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
    // "Stale Location" now renders twice (the item's own title headline, and
    // the new type-label span) — this fixture's title happens to match its
    // type label 1:1, so disambiguate by count rather than text alone.
    expect(screen.getAllByText('Stale Location')).toHaveLength(2);
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
    expect(screen.getAllByText('Stale Location')).toHaveLength(2);
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

  it('shows a human-friendly type label instead of the raw AttentionType enum', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({ items: [ATTENTION_ITEM], total: 1, page: 1, pageSize: 25 }),
      ),
    );

    renderList();

    expect(
      await screen.findByText('Stale Location', { selector: 'span.needs-attention-item-type' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('STALE_LOCATION')).not.toBeInTheDocument();
  });

  it('shows a human-friendly label for MANUAL_RISK_FLAG and renders the dispatcher reason verbatim as plain text', async () => {
    const reason = '<b>Driver</b> says "reefer" is not starting & 4h away';
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({
          items: [
            {
              ...ATTENTION_ITEM,
              id: 'risk-1',
              type: 'MANUAL_RISK_FLAG',
              severity: 'MEDIUM',
              title: 'Dispatcher Flagged: At Risk',
              reason,
              metadata: { riskStatus: 'AT_RISK' },
            },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
        }),
      ),
    );

    renderList();

    expect(
      await screen.findByText('Dispatcher-Flagged Risk', {
        selector: 'span.needs-attention-item-type',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('MANUAL_RISK_FLAG')).not.toBeInTheDocument();
    // React escapes the dispatcher's free text — shown literally, never parsed as markup
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(document.querySelector('.needs-attention-reason b')).toBeNull();
    expect(screen.getByText('MEDIUM')).toBeInTheDocument();
  });

  it('renders a raw future/unknown AttentionType as its own label rather than crashing', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({
          items: [
            {
              ...ATTENTION_ITEM,
              id: 'future-1',
              type: 'FUTURE_DETECTOR_TYPE',
              title: 'Future Thing',
            },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
        }),
      ),
    );

    renderList();

    expect(await screen.findByText('Future Thing')).toBeInTheDocument();
    expect(screen.getByText('FUTURE_DETECTOR_TYPE')).toBeInTheDocument();
  });

  it('distinguishes an AttentionItem from a legacy Notification via a source badge', async () => {
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

    expect(await screen.findByText('Notification')).toBeInTheDocument();
    expect(screen.getByText('Attention')).toBeInTheDocument();
  });

  it('renders a "View Load" action for a VIEW_LOAD suggested action, linking to the load', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({ items: [ATTENTION_ITEM], total: 1, page: 1, pageSize: 25 }),
      ),
    );

    renderList();

    const viewLoad = await screen.findByText('View Load');
    expect(viewLoad.closest('a')).toHaveAttribute('href', '/loads/load-2');
  });

  it('renders no action for a Notification item (null suggestedActions)', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({ items: [NOTIFICATION_ITEM], total: 1, page: 1, pageSize: 25 }),
      ),
    );

    renderList();

    expect(await screen.findByText('LOAD-000001')).toBeInTheDocument();
    expect(screen.queryByText('View Load')).not.toBeInTheDocument();
  });

  it('safely ignores an unrecognized suggested action type instead of inventing behavior', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({
          items: [
            { ...ATTENTION_ITEM, suggestedActions: [{ type: 'FUTURE_ACTION', phone: '555-0100' }] },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
        }),
      ),
    );

    renderList();

    expect(await screen.findByText('LOAD-000002')).toBeInTheDocument();
    expect(screen.queryByText('View Load')).not.toBeInTheDocument();
    expect(screen.queryByText(/FUTURE_ACTION/)).not.toBeInTheDocument();
  });

  it('shows a days-overdue magnitude cue for MISSING_POD, derived from metadata.ageHours', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({ items: [MISSING_POD_ITEM], total: 1, page: 1, pageSize: 25 }),
      ),
    );

    renderList();

    expect(await screen.findByText('29.5 days overdue')).toBeInTheDocument();
    // severity is untouched — still HIGH, not a new tier
    expect(screen.getByText('HIGH')).toBeInTheDocument();
  });

  it('shows no age cue for a non-MISSING_POD item, even if metadata happens to have an ageHours-shaped field', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({
          items: [{ ...ATTENTION_ITEM, metadata: { ageMinutes: 185 } }],
          total: 1,
          page: 1,
          pageSize: 25,
        }),
      ),
    );

    renderList();

    expect(await screen.findByText('LOAD-000002')).toBeInTheDocument();
    expect(screen.queryByText(/days overdue/)).not.toBeInTheDocument();
  });

  it('safely handles malformed suggestedActions shapes without crashing — non-array, array of non-objects, and objects missing type', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({
          items: [
            {
              ...ATTENTION_ITEM,
              id: 'malformed-non-array',
              loadId: 'load-10',
              loadNumber: 'LOAD-000010',
              suggestedActions: 'not-an-array',
            },
            {
              ...ATTENTION_ITEM,
              id: 'malformed-non-object-entries',
              loadId: 'load-11',
              loadNumber: 'LOAD-000011',
              suggestedActions: [null, 'a-string', 42],
            },
            {
              ...ATTENTION_ITEM,
              id: 'malformed-missing-type',
              loadId: 'load-12',
              loadNumber: 'LOAD-000012',
              suggestedActions: [{ phone: '555-0100' }],
            },
          ],
          total: 3,
          page: 1,
          pageSize: 25,
        }),
      ),
    );

    renderList();

    // The component must render all three rows without throwing, and must
    // never render a "View Load" action for any of these malformed shapes.
    expect(await screen.findByText('LOAD-000010')).toBeInTheDocument();
    expect(screen.getByText('LOAD-000011')).toBeInTheDocument();
    expect(screen.getByText('LOAD-000012')).toBeInTheDocument();
    expect(screen.queryByText('View Load')).not.toBeInTheDocument();
  });

  it('safely handles invalid MISSING_POD age metadata — missing ageHours and non-numeric ageHours — without showing an invalid/NaN label', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({
          items: [
            {
              ...MISSING_POD_ITEM,
              id: 'pod-missing-age',
              loadId: 'load-20',
              loadNumber: 'LOAD-000020',
              metadata: { clockBasis: 'deliveredAuditEntry' },
            },
            {
              ...MISSING_POD_ITEM,
              id: 'pod-non-numeric-age',
              loadId: 'load-21',
              loadNumber: 'LOAD-000021',
              metadata: { ageHours: 'unknown', clockBasis: 'deliveredAuditEntry' },
            },
          ],
          total: 2,
          page: 1,
          pageSize: 25,
        }),
      ),
    );

    renderList();

    expect(await screen.findByText('LOAD-000020')).toBeInTheDocument();
    expect(screen.getByText('LOAD-000021')).toBeInTheDocument();
    expect(screen.queryByText(/days overdue/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    // severity remains untouched/visible regardless of the invalid metadata
    expect(screen.getAllByText('HIGH')).toHaveLength(2);
  });

  it('gives each "View Load" action a distinct accessible name including the load number', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({
          items: [
            { ...ATTENTION_ITEM, id: 'a-1', loadId: 'load-30', loadNumber: 'LOAD-000030' },
            { ...ATTENTION_ITEM, id: 'a-2', loadId: 'load-31', loadNumber: 'LOAD-000031' },
          ],
          total: 2,
          page: 1,
          pageSize: 25,
        }),
      ),
    );

    renderList();

    const firstLink = await screen.findByRole('link', { name: 'View Load LOAD-000030' });
    const secondLink = await screen.findByRole('link', { name: 'View Load LOAD-000031' });
    expect(firstLink).toHaveAttribute('href', '/loads/load-30');
    expect(secondLink).toHaveAttribute('href', '/loads/load-31');
  });
});
