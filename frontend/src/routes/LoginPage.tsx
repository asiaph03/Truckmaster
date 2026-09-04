import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { authApi } from '../api';
import { ApiError } from '../api/errors';
import { useSessionStore } from '../auth/session-store';
import { Button } from '../components/ui';
import './LoginPage.css';

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Password is required.'),
});
type LoginFormValues = z.infer<typeof loginSchema>;

export function LoginPage() {
  const applySession = useSessionStore((s) => s.applySession);
  const requireOrganizationSelection = useSessionStore((s) => s.requireOrganizationSelection);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({ resolver: zodResolver(loginSchema) });

  async function onSubmit(values: LoginFormValues) {
    setServerError(null);
    try {
      const result = await authApi.login(values);
      if (result.requiresOrganizationSelection) {
        requireOrganizationSelection(result.organizations);
        return;
      }
      // Auto-selected (exactly one active membership) — GET /auth/me
      // is the source of truth for the resulting session (§8/§9 of the
      // approved plan: one bootstrap path, not a second ad hoc one).
      const me = await authApi.me();
      applySession({
        userId: me.id,
        organizationId: me.organizationId,
        roles: me.roles,
        name: me.name,
        email: me.email,
        isPlatformSuperAdmin: me.isPlatformSuperAdmin,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        setServerError(error.message);
      } else {
        setServerError('Something went wrong. Please try again.');
      }
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit(onSubmit)} noValidate>
        <img className="login-logo" src="/tms-logo.png" alt="Truck Master Dispatching Services" />
        <h1 className="login-title">Truck Master TMS</h1>
        <p className="login-subtitle">Sign in to your account</p>

        {serverError ? <div className="login-error">{serverError}</div> : null}

        <label className="login-field">
          <span>Email</span>
          <input type="email" autoComplete="username" {...register('email')} />
          {errors.email ? <span className="login-field-error">{errors.email.message}</span> : null}
        </label>

        <label className="login-field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" {...register('password')} />
          {errors.password ? (
            <span className="login-field-error">{errors.password.message}</span>
          ) : null}
        </label>

        <Button type="submit" size="lg" loading={isSubmitting} style={{ width: '100%' }}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
