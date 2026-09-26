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

describe('NeedsAttentionList — Dashboard Map Phase companion panel', () => {
  it('renders real items linking to their Load', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () =>
        HttpResponse.json({
          items: [
            {
              id: 'notif-1',
              type: 'CHECK_CALL_OVERDUE',
              message: 'Check call overdue',
              loadId: 'load-1',
              loadNumber: 'LOAD-000001',
              createdAt: '2026-09-26T10:00:00Z',
            },
          ],
        }),
      ),
    );

    renderList();

    expect(await screen.findByText('LOAD-000001')).toBeInTheDocument();
    expect(screen.getByText('LOAD-000001').closest('a')).toHaveAttribute('href', '/loads/load-1');
    expect(screen.getByText('Check call overdue')).toBeInTheDocument();
  });

  it('shows a genuine empty state — never fake placeholder items — when nothing needs attention', async () => {
    server.use(
      http.get('/api/v1/dashboard/needs-attention', () => HttpResponse.json({ items: [] })),
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
        return HttpResponse.json({ items: [] });
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
});
