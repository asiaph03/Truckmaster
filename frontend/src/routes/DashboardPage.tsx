import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { reportingApi } from '../api';
import { EmptyState } from '../components/ui';
import './shared/ListPage.css';
import './DashboardPage.css';

function formatMoney(value: string): string {
  return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function KpiCard({ label, value, to }: { label: string; value: ReactNode; to?: string }) {
  const content = (
    <>
      <div className="dashboard-kpi-card-label">{label}</div>
      <div className="dashboard-kpi-card-value">{value}</div>
    </>
  );
  return to ? (
    <Link to={to} className="dashboard-kpi-card">
      {content}
    </Link>
  ) : (
    <div className="dashboard-kpi-card">{content}</div>
  );
}

/**
 * PRD §9 / Frontend Phase 10 — role-aware Dashboard. Renders strictly off
 * the keys `GET /dashboard` actually returns (backend-side role
 * filtering is the sole source of truth here — no client-side
 * role-to-section mapping). Admin and Operations Manager intentionally
 * render identically, since the backend gives both the same org-wide
 * response. KPI cards link to an existing screen only where one exists;
 * neither Quotes nor Carrier Payments support a URL-filterable status, so
 * those cards link to the plain list rather than inventing a filtered view.
 */
export function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => reportingApi.dashboard(),
  });

  if (isLoading || !data) {
    return <div>Loading…</div>;
  }

  const hasAnySection = Boolean(data.dispatcher || data.sales || data.accounting);

  return (
    <div>
      <h1 className="list-page-title" style={{ marginBottom: 'var(--space-4)' }}>
        Dashboard
      </h1>

      {!hasAnySection ? (
        <EmptyState message="There are no Dashboard metrics available for your role yet." />
      ) : null}

      {data.dispatcher ? (
        <div className="dashboard-section">
          <h2 className="dashboard-section-title">Dispatch</h2>
          <div className="dashboard-kpi-cards">
            <KpiCard label="Active Loads" value={data.dispatcher.activeLoads} to="/loads/board" />
            <KpiCard
              label="At Risk / Delayed"
              value={data.dispatcher.atRiskOrDelayed}
              to="/loads/board"
            />
            <KpiCard label="Overdue Check Calls" value={data.dispatcher.overdueCheckCalls} />
          </div>
        </div>
      ) : null}

      {data.sales ? (
        <div className="dashboard-section">
          <h2 className="dashboard-section-title">Sales</h2>
          <div className="dashboard-kpi-cards">
            <KpiCard label="Open Quotes" value={data.sales.openQuotes} to="/quotes" />
            <KpiCard label="Won Last 30 Days" value={data.sales.wonLast30} to="/quotes" />
            <KpiCard label="Lost Last 30 Days" value={data.sales.lostLast30} to="/quotes" />
            <KpiCard
              label="Win Rate"
              value={`${(data.sales.winRate * 100).toFixed(0)}%`}
              to="/quotes"
            />
          </div>
        </div>
      ) : null}

      {data.accounting ? (
        <div className="dashboard-section">
          <h2 className="dashboard-section-title">Accounting</h2>
          <div className="dashboard-kpi-cards">
            <KpiCard
              label="AR Outstanding"
              value={formatMoney(data.accounting.arOutstanding)}
              to="/billing/ar-aging"
            />
            <KpiCard
              label="AR Overdue"
              value={formatMoney(data.accounting.arOverdue)}
              to="/billing/ar-aging"
            />
            <KpiCard
              label="AP Outstanding"
              value={formatMoney(data.accounting.apOutstanding)}
              to="/billing/ap-aging"
            />
            <KpiCard
              label="Pending Carrier Payments"
              value={data.accounting.pendingCarrierPayments}
              to="/billing/carrier-pay"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
