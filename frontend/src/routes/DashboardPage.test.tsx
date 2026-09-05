import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/mswServer';
import { DashboardPage } from './DashboardPage';

function renderDashboard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DashboardPage — Frontend Phase 10 (PRD §9)', () => {
  it('renders all three sections with the exact backend-provided values for a full-visibility role', async () => {
    server.use(
      http.get('/api/v1/dashboard', () =>
        HttpResponse.json({
          dispatcher: { activeLoads: 4, atRiskOrDelayed: 1, overdueCheckCalls: 2 },
          sales: { openQuotes: 3, wonLast30: 2, lostLast30: 2, winRate: 0.5 },
          accounting: {
            arOutstanding: '1800.00',
            arOverdue: '500.00',
            apOutstanding: '900.00',
            pendingCarrierPayments: 5,
          },
        }),
      ),
    );

    renderDashboard();

    await waitFor(() => expect(screen.getByText('Dispatch')).toBeInTheDocument());
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('Accounting')).toBeInTheDocument();
    expect(screen.getByText('$1,800.00')).toBeInTheDocument();
  });

  it('renders only the Dispatch section for a Dispatcher-only response', async () => {
    server.use(
      http.get('/api/v1/dashboard', () =>
        HttpResponse.json({
          dispatcher: { activeLoads: 1, atRiskOrDelayed: 0, overdueCheckCalls: 0 },
        }),
      ),
    );

    renderDashboard();

    await waitFor(() => expect(screen.getByText('Dispatch')).toBeInTheDocument());
    expect(screen.queryByText('Sales')).not.toBeInTheDocument();
    expect(screen.queryByText('Accounting')).not.toBeInTheDocument();
  });

  it('renders a neutral empty state, not an error, for a Compliance-Reviewer-only empty response', async () => {
    server.use(http.get('/api/v1/dashboard', () => HttpResponse.json({})));

    renderDashboard();

    await waitFor(() =>
      expect(
        screen.getByText('There are no Dashboard metrics available for your role yet.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('Dispatch')).not.toBeInTheDocument();
    expect(screen.queryByText('Sales')).not.toBeInTheDocument();
    expect(screen.queryByText('Accounting')).not.toBeInTheDocument();
  });

  it('links KPI cards to their existing destination screens', async () => {
    server.use(
      http.get('/api/v1/dashboard', () =>
        HttpResponse.json({
          dispatcher: { activeLoads: 1, atRiskOrDelayed: 0, overdueCheckCalls: 0 },
        }),
      ),
    );

    renderDashboard();

    await waitFor(() => expect(screen.getByText('Active Loads')).toBeInTheDocument());
    expect(screen.getByText('Active Loads').closest('a')).toHaveAttribute('href', '/loads/board');
    // Overdue Check Calls has no existing destination — must not be a link.
    expect(screen.getByText('Overdue Check Calls').closest('a')).toBeNull();
  });
});

describe('DashboardPage — initial load failure recovery (Task #4)', () => {
  it('shows an error state (not stuck Loading) when the initial GET fails, and Retry recovers it', async () => {
    let callCount = 0;
    server.use(
      http.get('/api/v1/dashboard', () => {
        callCount += 1;
        if (callCount === 1) {
          return HttpResponse.json(
            { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
            { status: 500 },
          );
        }
        return HttpResponse.json({
          dispatcher: { activeLoads: 4, atRiskOrDelayed: 1, overdueCheckCalls: 2 },
        });
      }),
    );

    renderDashboard();

    await waitFor(() =>
      expect(
        screen.getByText("Couldn't load the dashboard. Please try again."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByText('Dispatch')).toBeInTheDocument());
    expect(callCount).toBe(2);
  });
});
