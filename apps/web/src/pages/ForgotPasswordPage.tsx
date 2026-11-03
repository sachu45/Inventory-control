import { AuthLayout } from '@/components/auth/AuthLayout';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Link2, Mail } from '@/components/ui/icons';

import { TurnstileField } from '@/components/TurnstileField';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getApiErrorMessage } from '@/lib/api-error';
import { portalPost } from '@/lib/portal-api';
import { dashboardHomePath } from '@/lib/roles';
import { initializeSessionFromAuthResponse } from '@/lib/session';
import { useAuthStore } from '@/store/authStore';

type RequestMethod = 'otp' | 'magic_link';

export function ForgotPasswordPage() {
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [requestedMethod, setRequestedMethod] = useState<RequestMethod | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isRequesting, setIsRequesting] = useState(false);
  const [pendingMethod, setPendingMethod] = useState<RequestMethod | null>(null);
  const [isSubmittingOtp, setIsSubmittingOtp] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim();

  async function requestReset(method: RequestMethod) {
    if (isRequesting) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Enter a valid email address.'); return; }
    setIsRequesting(true);
    setPendingMethod(method);
    setError('');
    setMessage('');
    try {
      await portalPost('/auth/password-reset/request', {
        email: email.trim(),
        method,
      });
      setRequestedMethod(method);
      setMessage(
        method === 'otp'
          ? 'If the email exists, a 6-digit reset code has been sent. Enter it below with your new password.'
          : 'If the email exists, a reset link has been sent. Check your inbox and spam folder.',
      );
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not start the password reset flow.'));
    } finally {
      setIsRequesting(false);
      setPendingMethod(null);
    }
  }

  async function submitOtpReset(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmittingOtp) return;
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (siteKey && !turnstileToken) {
      setError('Complete the captcha and try again.');
      return;
    }

    setIsSubmittingOtp(true);
    setError('');
    try {
      const payload = await portalPost('/auth/password-reset/otp/complete', {
        email,
        otp: otp.trim(),
        newPassword,
        turnstileToken: turnstileToken || undefined,
      });
      await initializeSessionFromAuthResponse(payload, queryClient);
      nav(dashboardHomePath(useAuthStore.getState().user?.role));
    } catch (err) {
      // The captcha token was spent by this attempt; get a fresh one.
      setTurnstileResetKey((n) => n + 1);
      setError(getApiErrorMessage(err, 'Could not reset password with the code.'));
    } finally {
      setIsSubmittingOtp(false);
    }
  }

  return <AuthLayout headline="A fresh start.\nA secure workspace." description="Get back to your business with the account recovery options already set up for your workspace.">
    <div className="auth-form-heading"><span className="auth-eyebrow">ACCOUNT RECOVERY</span><h2>Forgot your password?</h2><p>We’ll help you get back into your workspace.</p></div>
    <Card className="auth-inner-card">
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10"
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Enter the email address you use for your workspace.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                type="button"
                variant="outline"
                className="justify-start gap-2"
                disabled={isRequesting || !email.trim()}
                onClick={() => requestReset('otp')}
              >
                <KeyRound className="h-4 w-4" />
                {isRequesting && pendingMethod === 'otp' ? 'Sending code...' : 'Send code'}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="justify-start gap-2"
                disabled={isRequesting || !email.trim()}
                onClick={() => requestReset('magic_link')}
              >
                <Link2 className="h-4 w-4" />
                {isRequesting && pendingMethod === 'magic_link' ? 'Sending link...' : 'Send reset link'}
              </Button>
            </div>

            {message ? (
              <div className="rounded-md border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">
                {message}
              </div>
            ) : null}

            {error ? (
              <div role="alert" className="rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : null}

            {requestedMethod === 'otp' ? (
              <form className="space-y-4 border-t border-border pt-5" onSubmit={submitOtpReset}>
                <div className="space-y-2">
                  <Label htmlFor="otp">Reset code</Label>
                  <Input
                    id="otp"
                    required
                    pattern="[0-9]{6}"
                    maxLength={6}
                    inputMode="numeric"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    placeholder="6-digit code"
                    autoComplete="one-time-code"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-password">New password</Label>
                  <Input
                    id="new-password"
                  required
                  minLength={10}
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoComplete="new-password"
                    placeholder="At least 10 characters"
                  />
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

                <TurnstileField siteKey={siteKey} onToken={setTurnstileToken} resetKey={turnstileResetKey} />

                <Button type="submit" className="w-full" disabled={isSubmittingOtp}>
                  {isSubmittingOtp ? 'Resetting password...' : 'Reset password and sign in'}
                </Button>
              </form>
            ) : null}

            <p className="text-center text-sm text-muted-foreground">
              Remembered it?{' '}
              <Link to="/login" className="font-medium text-primary hover:underline">
                Back to sign in
              </Link>
            </p>
          </CardContent>
        </Card>
  </AuthLayout>;
}
export default ForgotPasswordPage;
