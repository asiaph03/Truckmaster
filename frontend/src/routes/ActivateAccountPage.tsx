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
 * Frontend Phase 23 — activation/verification landing page for the
 * invitation and initial-admin-verification emails (MembershipService.
 * invite/resend, OrganizationService.createOrganization). Mounted at both
 * /accept-invitation and /verify (App.tsx) since the backend treats both
 * link types as the same operation (POST /auth/activate — see that
 * endpoint's own doc comment). Does not establish a session — the user
 * logs in normally afterward via the existing LoginPage.
 */
const activateSchema = z.object({
  password: z
    .string()
    .min(10, 'Password must be at least 10 characters.')
    .regex(
      /^(?=.*[A-Za-z])(?=.*\d).+$/,
      'Password must contain at least one letter and one number.',
    ),
});
type ActivateFormValues = z.infer<typeof activateSchema>;

const REDIRECT_DELAY_MS = 2000;

export function ActivateAccountPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [serverError, setServerError] = useState<string | null>(null);
  const [activated, setActivated] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ActivateFormValues>({ resolver: zodResolver(activateSchema) });

  async function onSubmit(values: ActivateFormValues) {
    if (!token) return;
    setServerError(null);
    try {
      await authApi.activate({ token, password: values.password });
      setActivated(true);
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
            This link is missing its invitation token. Please use the link from your invitation
            email, or ask an Admin to resend it.
          </div>
        </div>
      </div>
    );
  }

  if (activated) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1 className="login-title">Truck Master TMS</h1>
          <p className="login-subtitle">Your account is activated. Redirecting to sign in…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit(onSubmit)} noValidate>
        <h1 className="login-title">Truck Master TMS</h1>
        <p className="login-subtitle">Set a password to activate your account</p>

        {serverError ? <div className="login-error">{serverError}</div> : null}

        <label className="login-field">
          <span>New Password</span>
          <input type="password" autoComplete="new-password" {...register('password')} />
          {errors.password ? (
            <span className="login-field-error">{errors.password.message}</span>
          ) : null}
        </label>

        <Button type="submit" size="lg" loading={isSubmitting} style={{ width: '100%' }}>
          Activate Account
        </Button>
      </form>
    </div>
  );
}
