import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Mail, Lock, Eye, EyeOff, ArrowRight, Truck, Users, FileText, BarChart3 } from 'lucide-react';
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

const FEATURES = [
  { icon: Truck, label: 'Manage Loads' },
  { icon: Users, label: 'Work with Carriers' },
  { icon: FileText, label: 'Simplify Billing' },
  { icon: BarChart3, label: 'Get Real-Time Insights' },
] as const;

export function LoginPage() {
  const applySession = useSessionStore((s) => s.applySession);
  const requireOrganizationSelection = useSessionStore((s) => s.requireOrganizationSelection);
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

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
      <div className="login-hero">
        <div className="login-hero-content">
          <img
            className="login-hero-logo"
            src="/truckmaster-logo.png"
            alt="TruckMaster — Transportation Management System"
          />

          <h1 className="login-hero-headline">
            Move Your
            <br />
            Operations <span className="login-hero-headline-accent">Forward</span>
          </h1>
          <p className="login-hero-subtext">
            A smarter, simpler way to manage your loads, carriers, customers, billing, and more —
            all in one place.
          </p>

          <ul className="login-hero-features">
            {FEATURES.map(({ icon: Icon, label }) => (
              <li key={label} className="login-hero-feature">
                <span className="login-hero-feature-icon" aria-hidden="true">
                  <Icon size={22} strokeWidth={1.75} />
                </span>
                <span>{label}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="login-hero-tagline">
          Drive efficiency.
          <br />
          Deliver more.
        </p>
      </div>

      <div className="login-panel">
        <img
          className="login-panel-watermark"
          src="/truckmaster-logo.png"
          alt=""
          aria-hidden="true"
        />
        <form className="login-card" onSubmit={handleSubmit(onSubmit)} noValidate>
          <h2 className="login-title">Welcome Back</h2>
          <p className="login-subtitle">Log in to your Truck Master account</p>

          {serverError ? <div className="login-error">{serverError}</div> : null}

          <label className="login-field">
            <span>Email Address</span>
            <span className="login-input-wrap">
              <Mail className="login-input-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
              <input
                type="email"
                autoComplete="username"
                placeholder="you@company.com"
                {...register('email')}
              />
            </span>
            {errors.email ? <span className="login-field-error">{errors.email.message}</span> : null}
          </label>

          <label className="login-field">
            <span>Password</span>
            <span className="login-input-wrap">
              <Lock className="login-input-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter your password"
                {...register('password')}
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <EyeOff size={18} strokeWidth={1.75} />
                ) : (
                  <Eye size={18} strokeWidth={1.75} />
                )}
              </button>
            </span>
            {errors.password ? (
              <span className="login-field-error">{errors.password.message}</span>
            ) : null}
          </label>

          <div className="login-forgot-row">
            {/* No password-reset flow exists in this application yet — this
                link is a visual placeholder only, matching the reference
                design, and intentionally does not navigate anywhere. */}
            <a
              className="login-forgot-link"
              href="#"
              onClick={(e) => e.preventDefault()}
            >
              Forgot password?
            </a>
          </div>

          <Button type="submit" size="lg" loading={isSubmitting} className="login-submit">
            Log In
            <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
          </Button>

          <p className="login-contact-admin">
            Don&apos;t have an account?{' '}
            {/* Same as the "Forgot password?" link above — no contact-admin
                route exists yet, so this is a styled visual placeholder,
                not a functional link. */}
            <a href="#" onClick={(e) => e.preventDefault()}>
              Contact your administrator.
            </a>
          </p>
        </form>

        <p className="login-footer">© {new Date().getFullYear()} Truck Master. All rights reserved.</p>
      </div>
    </div>
  );
}
