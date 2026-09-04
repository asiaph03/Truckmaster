import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { ToastViewport, useToastStore } from '../../components/ui';
import { PlatformOrganizationsPage } from './PlatformOrganizationsPage';

const CREATED_ORGANIZATION = {
  id: 'org-2',
  legalName: 'HelloFresh Newark',
  addressLine1: '60 Lister Ave',
  city: 'Newark',
  state: 'NJ',
  zip: '07105',
  country: 'US',
  primaryContactName: 'Jane Admin',
  primaryContactEmail: 'jane@hellofresh-newark.test',
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
        <PlatformOrganizationsPage />
        <ToastViewport />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText(/^Legal Name/), {
    target: { value: CREATED_ORGANIZATION.legalName },
  });
  fireEvent.change(screen.getByLabelText(/^Address Line 1/), {
    target: { value: CREATED_ORGANIZATION.addressLine1 },
  });
  fireEvent.change(screen.getByLabelText(/^City/), {
    target: { value: CREATED_ORGANIZATION.city },
  });
  fireEvent.change(screen.getByLabelText(/^State/), {
    target: { value: CREATED_ORGANIZATION.state },
  });
  fireEvent.change(screen.getByLabelText(/^ZIP/), {
    target: { value: CREATED_ORGANIZATION.zip },
  });
  fireEvent.change(screen.getByLabelText(/^Primary Contact Name/), {
    target: { value: CREATED_ORGANIZATION.primaryContactName },
  });
  fireEvent.change(screen.getByLabelText(/^Primary Contact Email/), {
    target: { value: CREATED_ORGANIZATION.primaryContactEmail },
  });
  fireEvent.change(screen.getByLabelText(/^Primary Contact Phone/), {
    target: { value: CREATED_ORGANIZATION.primaryContactPhone },
  });
}

describe('PlatformOrganizationsPage — Platform Super Admin org creation', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [], isPlatformSuperAdmin: undefined });
    useToastStore.setState({ toasts: [] });
  });

  it('a Platform Super Admin session renders the Organizations screen and Create Organization action', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });

    renderPage();

    expect(await screen.findByText('Organizations')).toBeInTheDocument();
    expect(screen.getByText('+ Create Organization')).toBeInTheDocument();
    expect(screen.queryByText("You don't have access to this page.")).not.toBeInTheDocument();
  });

  it('a non-platform-super-admin session (including one holding the ADMIN membership role) sees permission-denied, never the create action — proving ADMIN role != platform super admin', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: false, roles: ['ADMIN'] });

    renderPage();

    expect(await screen.findByText("You don't have access to this page.")).toBeInTheDocument();
    expect(screen.queryByText('Organizations')).not.toBeInTheDocument();
    expect(screen.queryByText('+ Create Organization')).not.toBeInTheDocument();
  });

  it('submits exactly the expected body to POST /platform/organizations, without defaultPaymentTerms', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });
    let receivedBody: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/v1/platform/organizations', async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ organization: CREATED_ORGANIZATION }, { status: 201 });
      }),
    );

    renderPage();
    fireEvent.click(screen.getByText('+ Create Organization'));
    fillRequiredFields();
    fireEvent.click(screen.getByText('Create Organization'));

    await waitFor(() => expect(receivedBody).toBeDefined());
    expect(receivedBody).toEqual({
      legalName: CREATED_ORGANIZATION.legalName,
      addressLine1: CREATED_ORGANIZATION.addressLine1,
      city: CREATED_ORGANIZATION.city,
      state: CREATED_ORGANIZATION.state,
      zip: CREATED_ORGANIZATION.zip,
      country: '',
      primaryContactName: CREATED_ORGANIZATION.primaryContactName,
      primaryContactEmail: CREATED_ORGANIZATION.primaryContactEmail,
      primaryContactPhone: CREATED_ORGANIZATION.primaryContactPhone,
    });
    expect(receivedBody).not.toHaveProperty('defaultPaymentTerms');
  });

  it('shows an inline validation error and never calls the API when a required field is left blank', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });
    let called = false;
    server.use(
      http.post('/api/v1/platform/organizations', () => {
        called = true;
        return HttpResponse.json({ organization: CREATED_ORGANIZATION }, { status: 201 });
      }),
    );

    renderPage();
    fireEvent.click(screen.getByText('+ Create Organization'));
    // Deliberately leave every field blank.
    fireEvent.click(screen.getByText('Create Organization'));

    await waitFor(() => expect(screen.getByText('Legal name is required.')).toBeInTheDocument());
    expect(called).toBe(false);
  });

  it('a successful creation shows the organization name, invited email, and a success toast', async () => {
    useSessionStore.setState({ isPlatformSuperAdmin: true });
    server.use(
      http.post('/api/v1/platform/organizations', () =>
        HttpResponse.json({ organization: CREATED_ORGANIZATION }, { status: 201 }),
      ),
    );

    renderPage();
    fireEvent.click(screen.getByText('+ Create Organization'));
    fillRequiredFields();
    fireEvent.click(screen.getByText('Create Organization'));

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Organization created successfully.' }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(CREATED_ORGANIZATION.legalName)).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, node) =>
          node?.textContent ===
          `An invitation has been sent to ${CREATED_ORGANIZATION.primaryContactEmail}.`,
      ),
    ).toBeInTheDocument();
  });
});
