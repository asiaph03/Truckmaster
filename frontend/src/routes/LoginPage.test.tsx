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

  it('renders the TruckMaster logo using the provided asset, with descriptive alt text', () => {
    render(<LoginPage />);

    const logo = screen.getByAltText(
      'TruckMaster — Transportation Management System',
    ) as HTMLImageElement;
    expect(logo).toBeInTheDocument();
    expect(logo.tagName).toBe('IMG');
    expect(logo.getAttribute('src')).toBe('/truckmaster-logo.png');
  });

  it('places the logo above the login form fields', () => {
    render(<LoginPage />);

    const logo = screen.getByAltText('TruckMaster — Transportation Management System');
    const emailField = screen.getByLabelText('Email Address');
    // DOCUMENT_POSITION_FOLLOWING (4) means emailField comes after logo in the DOM.
    // eslint-disable-next-line no-bitwise
    expect(
      logo.compareDocumentPosition(emailField) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('still renders the existing email/password fields and Log In button, unchanged', () => {
    render(<LoginPage />);

    expect(screen.getByText('Welcome Back')).toBeInTheDocument();
    expect(screen.getByText('Log in to your Truck Master account')).toBeInTheDocument();
    expect(screen.getByLabelText('Email Address')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Log In/ })).toBeInTheDocument();
  });

  it('still validates required fields client-side, unchanged by the redesign', async () => {
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: /Log In/ }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Password is required.')).toBeInTheDocument();
  });

  it('toggles password visibility without affecting the field value', () => {
    render(<LoginPage />);

    const passwordInput = screen.getByLabelText('Password') as HTMLInputElement;
    expect(passwordInput.type).toBe('password');

    fireEvent.change(passwordInput, { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(passwordInput.type).toBe('text');
    expect(passwordInput.value).toBe('secret123');

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(passwordInput.type).toBe('password');
    expect(passwordInput.value).toBe('secret123');
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

    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'jane@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: /Log In/ }));

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

    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'jane@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: /Log In/ }));

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

    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'sam@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: /Log In/ }));

    await waitFor(() => expect(useSessionStore.getState().status).toBe('authenticated'));
    expect(useSessionStore.getState().isPlatformSuperAdmin).toBeFalsy();
  });
});
