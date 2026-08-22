import { useEffect } from 'react';
import { useSessionStore } from './auth/session-store';
import { LoginPage } from './routes/LoginPage';
import { SelectOrganizationPage } from './routes/SelectOrganizationPage';
import { AppShellPlaceholder } from './routes/AppShellPlaceholder';
import { ToastViewport } from './components/ui';

/**
 * §8/§9 of the approved Phase 1 plan: GET /auth/me on boot is the sole
 * point session state is "trusted"; every screen after that reads the
 * store. No router is wired to real screens yet (Phase 2+) — the four
 * states below are the entire Phase 1 "routing."
 */
function App() {
  const status = useSessionStore((s) => s.status);
  const bootstrap = useSessionStore((s) => s.bootstrap);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  return (
    <>
      {status === 'loading' ? <BootLoading /> : null}
      {status === 'unauthenticated' ? <LoginPage /> : null}
      {status === 'organization-selection-required' ? <SelectOrganizationPage /> : null}
      {status === 'authenticated' ? <AppShellPlaceholder /> : null}
      <ToastViewport />
    </>
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
