import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { ToastViewport, useToastStore } from '../../components/ui';
import { OrganizationSettingsPage } from './OrganizationSettingsPage';

const ORGANIZATION = {
  id: 'org-1',
  legalName: 'Acme Freight LLC',
  addressLine1: '1 Main St',
  city: 'Dallas',
  state: 'TX',
  zip: '75201',
  country: 'US',
  primaryContactName: 'Jane Admin',
  primaryContactEmail: 'jane@acme-freight.test',
  primaryContactPhone: '555-0100',
  defaultPaymentTerms: 'NET_30',
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <OrganizationSettingsPage />
        <ToastViewport />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OrganizationSettingsPage — Frontend Phase 14', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
    useToastStore.setState({ toasts: [] });
  });

  it('shows a loading state, then the fetched organization values populate the form', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(http.get('/api/v1/organizations/current', () => HttpResponse.json(ORGANIZATION)));

    renderPage();

    expect(screen.getByText('Loading…')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByDisplayValue('Acme Freight LLC')).toBeInTheDocument());
    expect(screen.getByDisplayValue('jane@acme-freight.test')).toBeInTheDocument();
  });

  it('submits only the changed fields and shows a success toast', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let receivedBody: Record<string, unknown> | undefined;
    server.use(
      http.get('/api/v1/organizations/current', () => HttpResponse.json(ORGANIZATION)),
      http.patch('/api/v1/organizations/current', async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...ORGANIZATION, city: 'Fort Worth' });
      }),
    );

    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Dallas')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('Dallas'), { target: { value: 'Fort Worth' } });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => expect(receivedBody).toBeDefined());
    expect(receivedBody).toMatchObject({ city: 'Fort Worth' });
    await waitFor(() =>
      expect(screen.getByText('Organization settings saved.')).toBeInTheDocument(),
    );
  });

  it('production bug fix — sends ONLY the fields UpdateOrganizationDto accepts, never id/status/createdByUserId/createdAt, even when the GET response includes read-only fields the frontend type does not declare', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    let receivedBody: Record<string, unknown> | undefined;
    server.use(
      // Deliberately includes `createdByUserId` — a real backend field
      // that GET /organizations/current returns but the frontend's own
      // `Organization` TS type does not declare. The fix must not leak
      // this through regardless of whether the type "knows" about it.
      http.get('/api/v1/organizations/current', () =>
        HttpResponse.json({ ...ORGANIZATION, createdByUserId: 'user-999' }),
      ),
      http.patch('/api/v1/organizations/current', async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(ORGANIZATION);
      }),
    );

    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Dallas')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('Dallas'), { target: { value: 'Fort Worth' } });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => expect(receivedBody).toBeDefined());
    expect(receivedBody).toEqual({
      legalName: 'Acme Freight LLC',
      addressLine1: '1 Main St',
      city: 'Fort Worth',
      state: 'TX',
      zip: '75201',
      country: 'US',
      primaryContactName: 'Jane Admin',
      primaryContactEmail: 'jane@acme-freight.test',
      primaryContactPhone: '555-0100',
      defaultPaymentTerms: 'NET_30',
    });
    expect(receivedBody).not.toHaveProperty('id');
    expect(receivedBody).not.toHaveProperty('status');
    expect(receivedBody).not.toHaveProperty('createdByUserId');
    expect(receivedBody).not.toHaveProperty('createdAt');
  });

  it('a second edit-and-save cycle (after the post-save reset) still sends only the allowed fields', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    const receivedBodies: Record<string, unknown>[] = [];
    server.use(
      http.get('/api/v1/organizations/current', () => HttpResponse.json(ORGANIZATION)),
      http.patch('/api/v1/organizations/current', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        receivedBodies.push(body);
        return HttpResponse.json({ ...ORGANIZATION, city: body.city as string });
      }),
    );

    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Dallas')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('Dallas'), { target: { value: 'Fort Worth' } });
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(receivedBodies).toHaveLength(1));

    // The post-save `reset(updated)` re-seeds the form from the PATCH
    // response — confirm that response's shape doesn't leak either. Wait
    // for the form to fully settle (isDirty back to false, button
    // disabled again) before the second edit, so this doesn't race the
    // async post-save reset.
    await waitFor(() => expect(screen.getByText('Save Changes').closest('button')).toBeDisabled());
    expect(screen.getByDisplayValue('Fort Worth')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('Fort Worth'), { target: { value: 'Arlington' } });
    await waitFor(() => expect(screen.getByDisplayValue('Arlington')).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText('Save Changes').closest('button')).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => expect(receivedBodies).toHaveLength(2));
    for (const body of receivedBodies) {
      expect(body).not.toHaveProperty('id');
      expect(body).not.toHaveProperty('status');
      expect(body).not.toHaveProperty('createdByUserId');
      expect(body).not.toHaveProperty('createdAt');
    }
  });

  it('shows the backend rejection message when an update is invalid, and does not silently succeed', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.get('/api/v1/organizations/current', () => HttpResponse.json(ORGANIZATION)),
      http.patch('/api/v1/organizations/current', () =>
        HttpResponse.json(
          { error: { code: 'VALIDATION_ERROR', message: 'primaryContactEmail must be an email' } },
          { status: 400 },
        ),
      ),
    );

    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('Dallas')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('Dallas'), { target: { value: 'Arlington' } });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() =>
      expect(screen.getByText('primaryContactEmail must be an email')).toBeInTheDocument(),
    );
    // The form isn't reset/cleared on a failed save — the attempted edit stays visible.
    expect(screen.getByDisplayValue('Arlington')).toBeInTheDocument();
  });

  it('shows the permission-denied state for a non-Admin, and never requests organization data', async () => {
    useSessionStore.setState({ roles: ['DISPATCHER'] });
    let requested = false;
    server.use(
      http.get('/api/v1/organizations/current', () => {
        requested = true;
        return HttpResponse.json(ORGANIZATION);
      }),
    );

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("You don't have access to this page.")).toBeInTheDocument(),
    );
    expect(requested).toBe(false);
  });
});
