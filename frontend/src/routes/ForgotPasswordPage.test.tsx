import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '../test/mswServer';
import { ForgotPasswordPage } from './ForgotPasswordPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );
}

describe('ForgotPasswordPage', () => {
  it('renders an email field and a submit button', () => {
    renderPage();

    expect(screen.getByLabelText('Email Address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send Reset Link' })).toBeInTheDocument();
  });

  it('validates email client-side before submitting', async () => {
    let called = false;
    server.use(
      http.post('/api/v1/auth/forgot-password', () => {
        called = true;
        return HttpResponse.json({ success: true });
      }),
    );
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Send Reset Link' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('shows the identical generic success message for any submitted email — never reveals account existence', async () => {
    server.use(
      http.post('/api/v1/auth/forgot-password', () => HttpResponse.json({ success: true })),
    );
    renderPage();

    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'anyone@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Reset Link' }));

    expect(
      await screen.findByText(
        'If an account exists for that email address, a password reset link has been sent. Check your inbox.',
      ),
    ).toBeInTheDocument();
  });

  it('sends exactly the submitted email to POST /auth/forgot-password', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/v1/auth/forgot-password', async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ success: true });
      }),
    );
    renderPage();

    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'jane@acme-freight.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Reset Link' }));

    await waitFor(() => expect(receivedBody).toEqual({ email: 'jane@acme-freight.test' }));
  });

  it('shows a client-error message only for a genuine network/request failure, never implying the account does not exist', async () => {
    server.use(http.post('/api/v1/auth/forgot-password', () => HttpResponse.error()));
    renderPage();

    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'jane@acme-freight.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Reset Link' }));

    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
  });
});
