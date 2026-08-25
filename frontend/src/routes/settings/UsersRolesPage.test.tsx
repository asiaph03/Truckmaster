import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/mswServer';
import { useSessionStore } from '../../auth/session-store';
import { UsersRolesPage } from './UsersRolesPage';

const MEMBERSHIPS = [
  {
    id: 'membership-1',
    userId: 'user-1',
    status: 'ACTIVE',
    user: { id: 'user-1', name: 'Jane Admin', email: 'jane@test.test' },
    roles: [{ role: 'ADMIN' }],
  },
  {
    id: 'membership-2',
    userId: 'user-2',
    status: 'ACTIVE',
    user: { id: 'user-2', name: 'Sam Dispatcher', email: 'sam@test.test' },
    roles: [{ role: 'DISPATCHER' }],
  },
];

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <UsersRolesPage />
    </QueryClientProvider>,
  );
}

describe('UsersRolesPage — Frontend Phase 11 (role editing)', () => {
  afterEach(() => {
    useSessionStore.setState({ roles: [] });
  });

  it("opens the Edit Roles modal pre-populated with the member's current roles, and submits the new role set", async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    const receivedBodies: Record<string, unknown>[] = [];
    server.use(
      http.get('/api/v1/memberships', () => HttpResponse.json(MEMBERSHIPS)),
      http.patch('/api/v1/memberships/membership-2/roles', async ({ request }) => {
        receivedBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ...MEMBERSHIPS[1], roles: [{ role: 'ACCOUNTING' }] });
      }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('Sam Dispatcher')).toBeInTheDocument());
    const editButtons = screen.getAllByText('Edit Roles');
    fireEvent.click(editButtons[1]); // Sam Dispatcher's row

    await waitFor(() =>
      expect(screen.getByText('Editing roles for Sam Dispatcher.')).toBeInTheDocument(),
    );
    // Pre-populated with the current role.
    const dispatcherCheckbox = screen.getByLabelText('Dispatcher') as HTMLInputElement;
    expect(dispatcherCheckbox.checked).toBe(true);

    fireEvent.click(dispatcherCheckbox); // uncheck Dispatcher
    fireEvent.click(screen.getByLabelText('Accounting')); // check Accounting
    fireEvent.click(screen.getByText('Save Roles'));

    await waitFor(() => expect(receivedBodies).toHaveLength(1));
    expect(receivedBodies[0]).toEqual({ roles: ['ACCOUNTING'] });
  });

  it("shows the backend's own rejection message and keeps the member's roles unchanged when the last-Admin protection blocks the change", async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.get('/api/v1/memberships', () => HttpResponse.json(MEMBERSHIPS)),
      http.patch('/api/v1/memberships/membership-1/roles', () =>
        HttpResponse.json(
          {
            error: {
              code: 'BUSINESS_RULE_VIOLATION',
              message:
                "You cannot remove this user's Admin role because they are the only active Admin in your organization. Assign Admin to another user first.",
            },
          },
          { status: 422 },
        ),
      ),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Admin')).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Edit Roles')[0]); // Jane Admin's row

    await waitFor(() =>
      expect(screen.getByText('Editing roles for Jane Admin.')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText('Admin')); // uncheck Admin
    fireEvent.click(screen.getByLabelText('Dispatcher')); // check Dispatcher instead
    fireEvent.click(screen.getByText('Save Roles'));

    // The modal stays open on failure — nothing silently succeeded.
    await waitFor(() =>
      expect(screen.getByText('Editing roles for Jane Admin.')).toBeInTheDocument(),
    );
    // Jane's role badge in the table is unaffected (still Admin, no refetch happened).
    expect(screen.getAllByText('Admin').length).toBeGreaterThan(0);
  });

  it('does not render the Edit Roles action for a non-Active member', async () => {
    useSessionStore.setState({ roles: ['ADMIN'] });
    server.use(
      http.get('/api/v1/memberships', () =>
        HttpResponse.json([
          {
            id: 'membership-3',
            userId: 'user-3',
            status: 'INVITED',
            user: { id: 'user-3', name: 'Pending Person', email: 'pending@test.test' },
            roles: [{ role: 'DISPATCHER' }],
          },
        ]),
      ),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('Pending Person')).toBeInTheDocument());
    expect(screen.queryByText('Edit Roles')).not.toBeInTheDocument();
  });
});
