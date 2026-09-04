import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/mswServer';
import { SelectOrganizationPage } from './SelectOrganizationPage';
import { useSessionStore } from '../auth/session-store';

describe('SelectOrganizationPage — Platform Super Admin session propagation', () => {
  beforeEach(() => {
    useSessionStore.setState({
      status: 'organization-selection-required',
      userId: undefined,
      organizationId: undefined,
      roles: [],
      name: undefined,
      email: undefined,
      isPlatformSuperAdmin: undefined,
      pendingOrganizations: [
        { id: 'org-1', legalName: 'Org One' },
        { id: 'org-2', legalName: 'Org Two' },
      ],
      availableOrganizations: [],
    });
  });

  it('selecting an organization preserves the platform-super-admin flag from GET /auth/me', async () => {
    server.use(
      http.post('/api/v1/auth/select-organization', () => HttpResponse.json({ success: true })),
      http.get('/api/v1/auth/me', () =>
        HttpResponse.json({
          id: 'user-1',
          organizationId: 'org-1',
          roles: ['ADMIN'],
          name: 'Jane Admin',
          email: 'jane@example.com',
          isPlatformSuperAdmin: true,
        }),
      ),
    );
    render(<SelectOrganizationPage />);

    fireEvent.click(screen.getByText('Org One'));

    await waitFor(() => expect(useSessionStore.getState().status).toBe('authenticated'));
    expect(useSessionStore.getState().organizationId).toBe('org-1');
    expect(useSessionStore.getState().isPlatformSuperAdmin).toBe(true);
  });

  it('selecting an organization for a non-platform-super-admin never sets the flag to true', async () => {
    server.use(
      http.post('/api/v1/auth/select-organization', () => HttpResponse.json({ success: true })),
      http.get('/api/v1/auth/me', () =>
        HttpResponse.json({
          id: 'user-2',
          organizationId: 'org-2',
          roles: ['DISPATCHER'],
          name: 'Sam Dispatcher',
          email: 'sam@example.com',
          isPlatformSuperAdmin: false,
        }),
      ),
    );
    render(<SelectOrganizationPage />);

    fireEvent.click(screen.getByText('Org Two'));

    await waitFor(() => expect(useSessionStore.getState().status).toBe('authenticated'));
    expect(useSessionStore.getState().isPlatformSuperAdmin).toBeFalsy();
  });
});
