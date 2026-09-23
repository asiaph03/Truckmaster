import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { authApi } from '../api';
import { ApiError } from '../api/errors';
import { Button } from '../components/ui';
import './LoginPage.css';

/**
 * Phase 6B — `POST /auth/forgot-password`. Structural sibling of
 * ActivateAccountPage.tsx (same login-card shell/CSS). The success state
 * is shown after every submission that passes client-side validation,
 * regardless of what the server actually did — the backend itself never
 * distinguishes "email matched an account" from any other case, and this
 * page must not either (locked decision — never reveal account existence).
 */
const forgotPasswordSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
});
type ForgotPasswordFormValues = z.infer<typeof forgotPasswordSchema>;

export function ForgotPasswordPage() {
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordFormValues>({ resolver: zodResolver(forgotPasswordSchema) });

  async function onSubmit(values: ForgotPasswordFormValues) {
    setServerError(null);
    try {
      await authApi.forgotPassword({ email: values.email });
      setSubmitted(true);
    } catch (error) {
      // Only a genuine client-side failure (network error, malformed
      // request) reaches here — the endpoint itself always returns
      // success, so this branch never reveals whether the account exists.
      if (error instanceof ApiError) {
        setServerError(error.message);
      } else {
        setServerError('Something went wrong. Please try again.');
      }
    }
  }

  if (submitted) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1 className="login-title">Truck Master TMS</h1>
          <p className="login-subtitle">
            If an account exists for that email address, a password reset link has been sent. Check
            your inbox.
          </p>
          <Link to="/">Back to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit(onSubmit)} noValidate>
        <h1 className="login-title">Truck Master TMS</h1>
        <p className="login-subtitle">Enter your email to reset your password</p>

        {serverError ? <div className="login-error">{serverError}</div> : null}

        <label className="login-field">
          <span>Email Address</span>
          <input
            type="email"
            autoComplete="username"
            placeholder="you@company.com"
            {...register('email')}
          />
          {errors.email ? <span className="login-field-error">{errors.email.message}</span> : null}
        </label>

        <Button type="submit" size="lg" loading={isSubmitting} style={{ width: '100%' }}>
          Send Reset Link
        </Button>

        <p className="login-contact-admin">
          <Link to="/">Back to sign in</Link>
        </p>
      </form>
    </div>
  );
}
