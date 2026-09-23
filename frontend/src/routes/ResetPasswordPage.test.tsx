import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '../test/mswServer';
import { ResetPasswordPage } from './ResetPasswordPage';

const TOKEN = 'a'.repeat(64);

function renderPage(initialEntry = `/reset-password?token=${TOKEN}`) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ResetPasswordPage />
    </MemoryRouter>,
  );
}

describe('ResetPasswordPage', () => {
  it('shows a missing-token error and no form when ?token= is absent', () => {
    renderPage('/reset-password');

    expect(screen.getByText(/This link is missing its reset token/)).toBeInTheDocument();
    expect(screen.queryByLabelText('New Password')).not.toBeInTheDocument();
  });

  it('renders password and confirm-password fields plus a submit button when a token is present', () => {
    renderPage();

    expect(screen.getByLabelText('New Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm New Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset Password' })).toBeInTheDocument();
  });

  it('enforces the same password rules as ActivateAccountPage — at least 10 characters, one letter, one number', async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'short1' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), {
      target: { value: 'short1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Password' }));

    expect(await screen.findByText('Password must be at least 10 characters.')).toBeInTheDocument();
  });

  it('rejects a password with no digit', async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'onlylettersnodigits' },
    });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), {
      target: { value: 'onlylettersnodigits' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Password' }));

    expect(
      await screen.findByText('Password must contain at least one letter and one number.'),
    ).toBeInTheDocument();
  });

  it('rejects mismatched password/confirmation', async () => {
    renderPage();

    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'GoodPassw0rd' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), {
      target: { value: 'DifferentPassw0rd' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Password' }));

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
  });

  it('submits the token and password to POST /auth/reset-password', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/v1/auth/reset-password', async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ success: true });
      }),
    );
    renderPage();

    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'GoodPassw0rd' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), {
      target: { value: 'GoodPassw0rd' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Password' }));

    await waitFor(() => expect(receivedBody).toEqual({ token: TOKEN, password: 'GoodPassw0rd' }));
  });

  it('shows a success state after a successful reset, same pattern as ActivateAccountPage', async () => {
    server.use(
      http.post('/api/v1/auth/reset-password', () => HttpResponse.json({ success: true })),
    );
    renderPage();

    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'GoodPassw0rd' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), {
      target: { value: 'GoodPassw0rd' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Password' }));

    expect(
      await screen.findByText('Your password has been reset. Redirecting to sign in…'),
    ).toBeInTheDocument();
    // The password/confirm-password form is gone — a second submission is impossible.
    expect(screen.queryByLabelText('New Password')).not.toBeInTheDocument();
  });

  it('shows a server error message on an invalid/expired token, without redirecting', async () => {
    server.use(
      http.post('/api/v1/auth/reset-password', () =>
        HttpResponse.json(
          {
            error: {
              code: 'AUTHENTICATION_ERROR',
              message: 'This password reset link is invalid or has expired.',
            },
          },
          { status: 401 },
        ),
      ),
    );
    renderPage();

    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'GoodPassw0rd' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), {
      target: { value: 'GoodPassw0rd' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Password' }));

    expect(
      await screen.findByText('This password reset link is invalid or has expired.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Your password has been reset. Redirecting to sign in…'),
    ).not.toBeInTheDocument();
  });
});
