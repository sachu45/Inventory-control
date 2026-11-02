import { AuthLayout } from '@/components/auth/AuthLayout';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Link2, LockKeyhole } from '@/components/ui/icons';
import { TurnstileField } from '@/components/TurnstileField';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getApiErrorMessage } from '@/lib/api-error';
import { portalGet, portalPost } from '@/lib/portal-api';
import { dashboardHomePath } from '@/lib/roles';
import { initializeSessionFromAuthResponse } from '@/lib/session';
import { useAuthStore } from '@/store/authStore';

type ResetPreview = {
  email: string;
  expiresAt: string;
};

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim();

  useEffect(() => {
    if (!token) {
      setError('Missing password reset token.');
      setState('error');
      return;
    }

    let cancelled = false;
    setState('loading');
    (async () => {
      try {
        const data = await portalGet<ResetPreview>('/auth/password-reset/link', { token });
        if (cancelled) return;
        setPreview(data);
        setState('ready');
      } catch (err) {
        if (cancelled) return;
        setError(getApiErrorMessage(err, 'Reset link is invalid or expired.'));
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (siteKey && !turnstileToken) {
      setError('Complete the captcha and try again.');
      return;
    }

    setIsSubmitting(true);
    setError('');
    try {
      const payload = await portalPost('/auth/password-reset/link/complete', {
        token,
        newPassword,
        turnstileToken: turnstileToken || undefined,
      });
      await initializeSessionFromAuthResponse(payload, queryClient);
      nav(dashboardHomePath(useAuthStore.getState().user?.role));
    } catch (err) {
      // The captcha token was spent by this attempt; get a fresh one.
      setTurnstileResetKey((n) => n + 1);
      setError(getApiErrorMessage(err, 'Could not reset the password.'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return <AuthLayout headline="A fresh start.\nA secure workspace." description="Get back to your business with the account recovery options already set up for your workspace.">
    <div className="auth-form-heading"><span className="auth-eyebrow">ACCOUNT RECOVERY</span><h2>Set a new password</h2><p>Choose a strong password to protect your account.</p></div>
    <Card className="auth-inner-card">
          <CardContent className="space-y-4">
            {state === 'loading' ? <p className="text-sm text-muted-foreground">Validating reset link...</p> : null}

            {state === 'error' ? (
              <>
                <div role="alert" className="rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                  {error}
                </div>
                <p className="text-xs text-muted-foreground">
                  Need another email? <Link to="/forgot-password" className="text-primary hover:underline">Request a new reset link</Link>.
                </p>
              </>
            ) : null}

            {state === 'ready' && preview ? (
              <form className="space-y-4" onSubmit={handleSubmit}>
                <div className="rounded-md bg-muted p-3 text-sm text-foreground">
                  <p className="font-medium">{preview.email}</p>
                  <p className="mt-1">This link expires at {new Date(preview.expiresAt).toLocaleString()}.</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="new-password">New password</Label>
                  <div className="relative">
                    <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="new-password"
                  required
                  minLength={10}
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                      className="pl-10"
                      placeholder="At least 10 characters"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm-password">Confirm password</Label>
                  <Input
                    id="confirm-password"
                  required
                  minLength={10}
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>

                {error ? (
                  <div role="alert" className="rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                    {error}
                  </div>
                ) : null}

                <TurnstileField siteKey={siteKey} onToken={setTurnstileToken} resetKey={turnstileResetKey} />

                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  <Link2 className="mr-2 h-4 w-4" />
                  {isSubmitting ? 'Resetting password...' : 'Reset password and sign in'}
                </Button>
              </form>
            ) : null}
          </CardContent>
        </Card>
    <Link className="auth-return-link" to="/login">Back to sign in</Link>
  </AuthLayout>;
}
export default ResetPasswordPage;
