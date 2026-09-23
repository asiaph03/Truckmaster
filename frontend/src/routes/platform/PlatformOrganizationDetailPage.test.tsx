import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { ToastViewport, useToastStore } from '../../components/ui';
import { PlatformOrganizationDetailPage } from './PlatformOrganizationDetailPage';

const ORG_ID = 'org-1';

function makeOrgDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: ORG_ID,
    legalName: 'Acme Freight LLC',
    primaryContactName: 'Jane Admin',
    primaryContactEmail: 'jane@acme-freight.test',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    subscriptionStatus: 'TRIAL',
    trialStartedAt: '2026-09-01T00:00:00.000Z',
    trialEndsAt: '2026-09-08T00:00:00.000Z',
    maxCarriers: 1,
    maxDrivers: 5,
    subscriptionConvertedAt: null,
    subscriptionConvertedByUserId: null,
    qualifyingCarrierCount: 0,
    qualifyingDriverCount: 0,
    ...overrides,
  };
}

function renderPage(detail: ReturnType<typeof makeOrgDetail>) {
  server.use(
    http.get(`/api/v1/platform/organizations/${ORG_ID}`, () => HttpResponse.json(detail)),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/platform/organizations/${ORG_ID}`]}>
        <Routes>
          <Route path="/platform/organizations/:id" element={<PlatformOrganizationDetailPage />} />
        </Routes>
      </MemoryRouter>
      <ToastViewport />
    </QueryClientProvider>,
  );
}

describe('PlatformOrganizationDetailPage', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [], isPlatformSuperAdmin: undefined });
    useToastStore.setState({ toasts: [] });
  });

  it('a non-platform-super-admin session sees permission-denied, never the org detail', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: false, roles: ['ADMIN'] });
    renderPage(makeOrgDetail());

    expect(await screen.findByText("You don't have access to this page.")).toBeInTheDocument();
    expect(screen.queryByText('Acme Freight LLC')).not.toBeInTheDocument();
  });

  it('renders subscription state, trial dates, limits, and current usage', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });
    renderPage(
      makeOrgDetail({ maxCarriers: 2, maxDrivers: 20, qualifyingCarrierCount: 1, qualifyingDriverCount: 3 }),
    );

    expect(await screen.findByRole('heading', { name: 'Acme Freight LLC' })).toBeInTheDocument();
    expect(screen.getAllByText('TRIAL').length).toBeGreaterThan(0);
    expect(screen.getByText('2')).toBeInTheDocument(); // Carrier Limit
    expect(screen.getByText('20')).toBeInTheDocument(); // Driver Limit
    expect(screen.getByText('1')).toBeInTheDocument(); // Qualifying Carriers
    expect(screen.getByText('3')).toBeInTheDocument(); // Active Drivers
  });

  it('shows the conversion action for a TRIAL organization', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });
    renderPage(makeOrgDetail({ subscriptionStatus: 'TRIAL' }));

    expect(await screen.findByText('Convert to Active Subscription')).toBeInTheDocument();
  });

  it('shows the conversion action for an EXPIRED organization', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });
    renderPage(makeOrgDetail({ subscriptionStatus: 'EXPIRED' }));

    expect(await screen.findByText('Convert to Active Subscription')).toBeInTheDocument();
  });

  it('does NOT show the conversion action for an already-ACTIVE organization', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });
    renderPage(makeOrgDetail({ subscriptionStatus: 'ACTIVE' }));

    await screen.findByRole('heading', { name: 'Acme Freight LLC' });
    expect(screen.queryByText('Max Carriers')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Convert to Active' })).not.toBeInTheDocument();
  });

  it('does NOT show the conversion action for a CANCELLED organization', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });
    renderPage(makeOrgDetail({ subscriptionStatus: 'CANCELLED' }));

    await screen.findByRole('heading', { name: 'Acme Freight LLC' });
    expect(screen.queryByText('Max Carriers')).not.toBeInTheDocument();
  });

  it('shows an informational (non-blocking) warning when the requested carrier limit is below current usage', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });
    renderPage(makeOrgDetail({ subscriptionStatus: 'TRIAL', qualifyingCarrierCount: 8 }));

    await screen.findByText('Convert to Active Subscription');
    fireEvent.change(screen.getByLabelText('Max Carriers'), { target: { value: '5' } });

    expect(
      await screen.findByText(/This organization currently has 8 qualifying carriers/),
    ).toBeInTheDocument();
    // Still not blocked — the Convert button remains present and enabled.
    expect(screen.getByRole('button', { name: 'Convert to Active' })).not.toBeDisabled();
  });

  it('shows no warning when the requested limit is at or above current usage', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });
    renderPage(makeOrgDetail({ subscriptionStatus: 'TRIAL', qualifyingCarrierCount: 2 }));

    await screen.findByText('Convert to Active Subscription');
    fireEvent.change(screen.getByLabelText('Max Carriers'), { target: { value: '5' } });

    expect(screen.queryByText(/qualifying carriers/)).not.toBeInTheDocument();
  });

  it('submits null for a blank limit input (unlimited) and the entered number otherwise, only after confirming', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });
    let receivedBody: Record<string, unknown> | undefined;
    renderPage(makeOrgDetail({ subscriptionStatus: 'TRIAL' }));
    server.use(
      http.patch(`/api/v1/platform/organizations/${ORG_ID}/subscription`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makeOrgDetail({ subscriptionStatus: 'ACTIVE' }));
      }),
    );

    await screen.findByText('Convert to Active Subscription');
    fireEvent.change(screen.getByLabelText('Max Carriers'), { target: { value: '5' } });
    // Max Drivers left blank — should be submitted as null (unlimited).

    fireEvent.click(screen.getByRole('button', { name: 'Convert to Active' }));
    // ConfirmDialog must appear — the API must not be called yet.
    const dialog = await screen.findByRole('dialog');
    expect(receivedBody).toBeUndefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Convert to Active' }));

    await waitFor(() => expect(receivedBody).toBeDefined());
    expect(receivedBody).toEqual({ maxCarriers: 5, maxDrivers: null });
  });

  it('shows a success toast after a successful conversion', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });
    renderPage(makeOrgDetail({ subscriptionStatus: 'TRIAL' }));
    server.use(
      http.patch(`/api/v1/platform/organizations/${ORG_ID}/subscription`, () =>
        HttpResponse.json(makeOrgDetail({ subscriptionStatus: 'ACTIVE' })),
      ),
    );

    await screen.findByText('Convert to Active Subscription');
    fireEvent.click(screen.getByRole('button', { name: 'Convert to Active' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Convert to Active' }));

    expect(await screen.findByText('Organization converted to an active subscription.')).toBeInTheDocument();
  });
});
