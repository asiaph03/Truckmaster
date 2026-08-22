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
import { AppShell } from './shell/AppShell';
import { ToastViewport } from './components/ui';

/**
 * §8/§9 of the approved Phase 1 plan: GET /auth/me on boot is the sole
 * point session state is "trusted"; every screen after that reads the
 * store. Phase 2 adds the real router, mapped 1:1 to the routes it
 * covers (Customers, Carriers) — everything else is a ComingSoonPage
 * placeholder per the approved scope (no Loads/Billing/Dashboard/
 * Reports/Settings screens yet).
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
        <Route path="/loads" element={<ComingSoonPage title="Loads" />} />
        <Route path="/customers" element={<CustomerListPage />} />
        <Route path="/customers/new" element={<CustomerCreatePage />} />
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
        <Route path="/carriers" element={<CarrierListPage />} />
        <Route path="/carriers/new" element={<CarrierCreatePage />} />
        <Route path="/carriers/:id" element={<CarrierDetailPage />} />
        <Route path="/billing" element={<ComingSoonPage title="Billing" />} />
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
