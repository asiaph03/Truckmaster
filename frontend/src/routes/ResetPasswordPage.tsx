import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { authApi } from '../api';
import { ApiError } from '../api/errors';
import { Button } from '../components/ui';
import './LoginPage.css';

/**
 * Phase 6B — landing page for the password-reset email's link
 * (`?token=`). Structural clone of ActivateAccountPage.tsx (same
 * token-from-URL / password-rules / success-then-redirect shape); the
 * password regex here is intentionally identical to that page's — both
 * exist purely to give the user instant feedback before submit, while
 * PasswordService.assertValid on the backend remains the actual source
 * of truth (a mismatch here would only ever produce an extra round trip,
 * never a security gap). Does not establish a session, same as
 * activation — the user signs in normally afterward via LoginPage.
 */
const resetPasswordSchema = z
  .object({
    password: z
      .string()
      .min(10, 'Password must be at least 10 characters.')
      .regex(
        /^(?=.*[A-Za-z])(?=.*\d).+$/,
        'Password must contain at least one letter and one number.',
      ),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });
type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>;

const REDIRECT_DELAY_MS = 2000;

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [serverError, setServerError] = useState<string | null>(null);
  const [reset, setReset] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordFormValues>({ resolver: zodResolver(resetPasswordSchema) });

  async function onSubmit(values: ResetPasswordFormValues) {
    if (!token) return;
    setServerError(null);
    try {
      await authApi.resetPassword({ token, password: values.password });
      setReset(true);
      window.setTimeout(() => {
        window.location.href = '/';
      }, REDIRECT_DELAY_MS);
    } catch (error) {
      if (error instanceof ApiError) {
        setServerError(error.message);
      } else {
        setServerError('Something went wrong. Please try again.');
      }
    }
  }

  if (!token) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1 className="login-title">Truck Master TMS</h1>
          <div className="login-error">
            This link is missing its reset token. Please use the link from your password reset
            email, or request a new one.
          </div>
        </div>
      </div>
    );
  }

  if (reset) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1 className="login-title">Truck Master TMS</h1>
          <p className="login-subtitle">Your password has been reset. Redirecting to sign in…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit(onSubmit)} noValidate>
        <h1 className="login-title">Truck Master TMS</h1>
        <p className="login-subtitle">Set a new password</p>

        {serverError ? <div className="login-error">{serverError}</div> : null}

        <label className="login-field">
          <span>New Password</span>
          <input type="password" autoComplete="new-password" {...register('password')} />
          {errors.password ? (
            <span className="login-field-error">{errors.password.message}</span>
          ) : null}
        </label>

        <label className="login-field">
          <span>Confirm New Password</span>
          <input type="password" autoComplete="new-password" {...register('confirmPassword')} />
          {errors.confirmPassword ? (
            <span className="login-field-error">{errors.confirmPassword.message}</span>
          ) : null}
        </label>

        <Button type="submit" size="lg" loading={isSubmitting} style={{ width: '100%' }}>
          Reset Password
        </Button>
      </form>
    </div>
  );
}
