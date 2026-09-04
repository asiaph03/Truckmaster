import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '../test/mswServer';
import { LoginPage } from '../routes/LoginPage';
import { useSessionStore } from '../auth/session-store';
import { UserMenu } from './UserMenu';

function renderLoginAndUserMenu() {
  return render(
    <MemoryRouter>
      <LoginPage />
      <UserMenu />
    </MemoryRouter>,
  );
}

describe('UserMenu — Platform Super Admin session propagation (no page refresh required)', () => {
  beforeEach(() => {
    useSessionStore.setState({
      status: 'unauthenticated',
      userId: undefined,
      organizationId: undefined,
      roles: [],
      name: undefined,
      email: undefined,
      isPlatformSuperAdmin: undefined,
      pendingOrganizations: [],
      availableOrganizations: [],
    });
  });

  it('renders "Platform Organizations" immediately after a Platform Super Admin logs in — same session, no bootstrap()/reload involved', async () => {
    server.use(
      http.post('/api/v1/auth/login', () =>
        HttpResponse.json({ requiresOrganizationSelection: false, organizations: [] }),
      ),
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
    renderLoginAndUserMenu();

    // Before login, the menu item must not exist at all (avatar not even open yet, but the item is absent from the DOM either way).
    expect(screen.queryByText('Platform Organizations')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jane@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(useSessionStore.getState().status).toBe('authenticated'));

    // Open the avatar menu — UserMenu is already mounted and reading the
    // same store LoginPage just updated; nothing here re-fetches /auth/me.
    fireEvent.click(screen.getByLabelText('User menu'));

    expect(await screen.findByText('Platform Organizations')).toBeInTheDocument();
  });

  it('never renders "Platform Organizations" for a non-platform-super-admin login', async () => {
    server.use(
      http.post('/api/v1/auth/login', () =>
        HttpResponse.json({ requiresOrganizationSelection: false, organizations: [] }),
      ),
      http.get('/api/v1/auth/me', () =>
        HttpResponse.json({
          id: 'user-2',
          organizationId: 'org-1',
          roles: ['DISPATCHER'],
          name: 'Sam Dispatcher',
          email: 'sam@example.com',
          isPlatformSuperAdmin: false,
        }),
      ),
    );
    renderLoginAndUserMenu();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(useSessionStore.getState().status).toBe('authenticated'));

    fireEvent.click(screen.getByLabelText('User menu'));

    expect(screen.getByText('Log out')).toBeInTheDocument();
    expect(screen.queryByText('Platform Organizations')).not.toBeInTheDocument();
  });
});
