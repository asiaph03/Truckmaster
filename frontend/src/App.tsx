import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useSessionStore } from './auth/session-store';
import { LoginPage } from './routes/LoginPage';
import { SelectOrganizationPage } from './routes/SelectOrganizationPage';
import { ComingSoonPage } from './routes/ComingSoonPage';
import { DashboardPage } from './routes/DashboardPage';
import { CustomerListPage } from './routes/customers/CustomerListPage';
import { CustomerCreatePage } from './routes/customers/CustomerCreatePage';
import { CustomerDetailPage } from './routes/customers/CustomerDetailPage';
import { CarrierListPage } from './routes/carriers/CarrierListPage';
import { CarrierCreatePage } from './routes/carriers/CarrierCreatePage';
import { CarrierDetailPage } from './routes/carriers/CarrierDetailPage';
import { ComplianceQueuePage } from './routes/carriers/ComplianceQueuePage';
import { DispatchBoardPage } from './routes/loads/DispatchBoardPage';
import { LoadSearchPage } from './routes/loads/LoadSearchPage';
import { LoadCreatePage } from './routes/loads/LoadCreatePage';
import { LoadDetailPage } from './routes/loads/LoadDetailPage';
import { LoadClosingPage } from './routes/loads/LoadClosingPage';
import { QuoteListPage } from './routes/quotes/QuoteListPage';
import { QuoteCreatePage } from './routes/quotes/QuoteCreatePage';
import { QuoteDetailPage } from './routes/quotes/QuoteDetailPage';
import { InvoiceListPage } from './routes/billing/InvoiceListPage';
import { InvoiceBuilderPage } from './routes/billing/InvoiceBuilderPage';
import { InvoiceDetailPage } from './routes/billing/InvoiceDetailPage';
import { CarrierPaymentListPage } from './routes/billing/CarrierPaymentListPage';
import { CarrierPaymentDetailPage } from './routes/billing/CarrierPaymentDetailPage';
import { ArAgingPage } from './routes/billing/ArAgingPage';
import { ApAgingPage } from './routes/billing/ApAgingPage';
import { UsersRolesPage } from './routes/settings/UsersRolesPage';
import { OrganizationSettingsPage } from './routes/settings/OrganizationSettingsPage';
import { AppShell } from './shell/AppShell';
import { ToastViewport } from './components/ui';

/**
 * §8/§9 of the approved Phase 1 plan: GET /auth/me on boot is the sole
 * point session state is "trusted"; every screen after that reads the
 * store. Phase 2 added Customers/Carriers; Phase 3 added the Load
 * lifecycle; Phase 4 added Financials & Load Closing. Phase 5 added AR/AP
 * Aging, the Compliance Review Queue, Settings → Users & Roles (invite/
 * resend/cancel/deactivate), the Dispatch Board's Kanban view, and the
 * Global Search palette. Phase 6 added the Dispatch Board's Calendar
 * view. Phase 7 added Load Detail's sixth tab, Activity History.
 * Table/Kanban/Calendar are one screen at `/loads/board?view=`, matching
 * the locked sitemap, not separate routes. Phase 10 added the role-aware
 * Dashboard (`/`), rendered strictly off `GET /dashboard`'s returned keys
 * — no client-side role-to-section mapping. Phase 11 added membership
 * role editing (`PATCH /memberships/:id/roles`) to Settings → Users &
 * Roles, with server-enforced last-active-Admin protection. Phase 13
 * added Load Search (`/loads/search`) — a dedicated all-loads (including
 * Closed), filterable/searchable/sortable/paginated/CSV-exportable
 * screen backed by its own `GET /loads/search` and
 * `GET /loads/search/export` endpoints, deliberately independent of
 * `GET /loads` so Dispatch Board's behavior is unaffected. Phase 14 added
 * Organization Settings (`/settings/organization`) — legal
 * name/address/primary contact/default payment terms, backed by
 * `GET`/`PATCH /organizations/current` (Admin-only, org-scoped, distinct
 * from the platform-console `/platform/organizations` route). Document
 * Center and the broader Reports library remain ComingSoonPage or
 * unbuilt — neither has a locked screen-level design yet.
 */
function App() {
  const status = useSessionStore((s) => s.status);
  const bootstrap = useSessionStore((s) => s.bootstrap);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  if (status === 'loading') return <BootLoading />;
  if (status === 'unauthenticated') {
    return (
      <>
        <LoginPage />
        <ToastViewport />
      </>
    );
  }
  if (status === 'organization-selection-required') {
    return (
      <>
        <SelectOrganizationPage />
        <ToastViewport />
      </>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/loads" element={<Navigate to="/loads/board" replace />} />
        <Route path="/loads/board" element={<DispatchBoardPage />} />
        <Route path="/loads/search" element={<LoadSearchPage />} />
        <Route path="/loads/new" element={<LoadCreatePage />} />
        <Route path="/loads/:id" element={<LoadDetailPage />} />
        <Route path="/loads/:id/close" element={<LoadClosingPage />} />
        <Route path="/quotes" element={<QuoteListPage />} />
        <Route path="/quotes/new" element={<QuoteCreatePage />} />
        <Route path="/quotes/:id" element={<QuoteDetailPage />} />
        <Route path="/customers" element={<CustomerListPage />} />
        <Route path="/customers/new" element={<CustomerCreatePage />} />
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
        <Route path="/carriers" element={<CarrierListPage />} />
        <Route path="/carriers/new" element={<CarrierCreatePage />} />
        <Route path="/carriers/compliance-queue" element={<ComplianceQueuePage />} />
        <Route path="/carriers/:id" element={<CarrierDetailPage />} />
        <Route path="/billing" element={<Navigate to="/billing/invoices" replace />} />
        <Route path="/billing/invoices" element={<InvoiceListPage />} />
        <Route path="/billing/invoices/new" element={<InvoiceBuilderPage />} />
        <Route path="/billing/invoices/:id" element={<InvoiceDetailPage />} />
        <Route path="/billing/carrier-pay" element={<CarrierPaymentListPage />} />
        <Route path="/billing/carrier-pay/:id" element={<CarrierPaymentDetailPage />} />
        <Route path="/billing/ar-aging" element={<ArAgingPage />} />
        <Route path="/billing/ap-aging" element={<ApAgingPage />} />
        <Route path="/documents" element={<ComingSoonPage title="Document Center" />} />
        <Route path="/reports" element={<ComingSoonPage title="Reports" />} />
        <Route path="/settings" element={<UsersRolesPage />} />
        <Route path="/settings/organization" element={<OrganizationSettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function BootLoading() {
  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span style={{ color: 'var(--neutral-500)' }}>Loading…</span>
    </div>
  );
}

export default App;
