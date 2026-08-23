import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useSessionStore } from './auth/session-store';
import { LoginPage } from './routes/LoginPage';
import { SelectOrganizationPage } from './routes/SelectOrganizationPage';
import { ComingSoonPage } from './routes/ComingSoonPage';
import { CustomerListPage } from './routes/customers/CustomerListPage';
import { CustomerCreatePage } from './routes/customers/CustomerCreatePage';
import { CustomerDetailPage } from './routes/customers/CustomerDetailPage';
import { CarrierListPage } from './routes/carriers/CarrierListPage';
import { CarrierCreatePage } from './routes/carriers/CarrierCreatePage';
import { CarrierDetailPage } from './routes/carriers/CarrierDetailPage';
import { DispatchBoardPage } from './routes/loads/DispatchBoardPage';
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
import { AppShell } from './shell/AppShell';
import { ToastViewport } from './components/ui';

/**
 * §8/§9 of the approved Phase 1 plan: GET /auth/me on boot is the sole
 * point session state is "trusted"; every screen after that reads the
 * store. Phase 2 added Customers/Carriers; Phase 3 added the Load
 * lifecycle; Phase 4 adds Financials & Load Closing (Invoice Builder/
 * List/Detail, Carrier Payment List/Detail, Load Closing). AR/AP Aging
 * are deferred (approved Phase 4 plan §8 decision 5) — no route for
 * them exists yet. Dashboard/Documents/Reports/Settings remain
 * ComingSoonPage per the approved scope.
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
        <Route path="/" element={<ComingSoonPage title="Dashboard" />} />
        <Route path="/loads" element={<Navigate to="/loads/board" replace />} />
        <Route path="/loads/board" element={<DispatchBoardPage />} />
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
        <Route path="/carriers/:id" element={<CarrierDetailPage />} />
        <Route path="/billing" element={<Navigate to="/billing/invoices" replace />} />
        <Route path="/billing/invoices" element={<InvoiceListPage />} />
        <Route path="/billing/invoices/new" element={<InvoiceBuilderPage />} />
        <Route path="/billing/invoices/:id" element={<InvoiceDetailPage />} />
        <Route path="/billing/carrier-pay" element={<CarrierPaymentListPage />} />
        <Route path="/billing/carrier-pay/:id" element={<CarrierPaymentDetailPage />} />
        <Route path="/documents" element={<ComingSoonPage title="Document Center" />} />
        <Route path="/reports" element={<ComingSoonPage title="Reports" />} />
        <Route path="/settings" element={<ComingSoonPage title="Settings" />} />
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
