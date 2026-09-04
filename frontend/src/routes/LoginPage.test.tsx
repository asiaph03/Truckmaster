import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/mswServer';
import { LoginPage } from './LoginPage';
import { useSessionStore } from '../auth/session-store';

describe('LoginPage — Truck Master logo branding', () => {
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

  it('renders the Truck Master logo using the provided asset, with descriptive alt text', () => {
    render(<LoginPage />);

    const logo = screen.getByAltText('Truck Master Dispatching Services') as HTMLImageElement;
    expect(logo).toBeInTheDocument();
    expect(logo.tagName).toBe('IMG');
    expect(logo.getAttribute('src')).toBe('/tms-logo.png');
  });

  it('places the logo above the login form fields', () => {
    render(<LoginPage />);

    const logo = screen.getByAltText('Truck Master Dispatching Services');
    const emailField = screen.getByLabelText('Email');
    // DOCUMENT_POSITION_FOLLOWING (4) means emailField comes after logo in the DOM.
    // eslint-disable-next-line no-bitwise
    expect(
      logo.compareDocumentPosition(emailField) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('still renders the existing email/password fields and Sign in button, unchanged', () => {
    render(<LoginPage />);

    expect(screen.getByText('Truck Master TMS')).toBeInTheDocument();
    expect(screen.getByText('Sign in to your account')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('still validates required fields client-side, unchanged by the logo addition', async () => {
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Password is required.')).toBeInTheDocument();
  });

  it('still logs in and applies the session on submit — authentication behavior unchanged', async () => {
    server.use(
      http.post('/api/v1/auth/login', () =>
        HttpResponse.json({ requiresOrganizationSelection: false, organizations: [] }),
      ),
      http.get('/api/v1/auth/me', () =>
        HttpResponse.json({
          id: 'user-1',
          organizationId: 'org-1',
          roles: ['ADMIN'],
          name: 'Jane Dispatcher',
          email: 'jane@example.com',
        }),
      ),
    );
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'jane@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(useSessionStore.getState().status).toBe('authenticated');
    });
    expect(useSessionStore.getState().userId).toBe('user-1');
    expect(useSessionStore.getState().organizationId).toBe('org-1');
  });
});

describe('LoginPage — Platform Super Admin session propagation', () => {
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

  it('a Platform Super Admin login immediately results in session.isPlatformSuperAdmin === true, with no page refresh', async () => {
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
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jane@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(useSessionStore.getState().status).toBe('authenticated'));
    expect(useSessionStore.getState().isPlatformSuperAdmin).toBe(true);
  });

  it('a non-platform-super-admin login results in isPlatformSuperAdmin false/undefined, never true', async () => {
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
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(useSessionStore.getState().status).toBe('authenticated'));
    expect(useSessionStore.getState().isPlatformSuperAdmin).toBeFalsy();
  });
});
