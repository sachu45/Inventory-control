import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
} from '@/components/ui/icons';
import { api } from '@/api/client';
import { AuthStepIndicator } from '@/components/auth/AuthStepIndicator';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { OtpCodeInput } from '@/components/auth/OtpCodeInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getApiErrorMessage } from '@/lib/api-error';
import { initializeSessionFromAuthResponse } from '@/lib/session';
import { useAuthStore } from '@/store/authStore';
import { useCookieConsentStore } from '@/store/cookieConsentStore';
import { dashboardHomePath } from '@/lib/roles';
import { signInDestination } from '@/lib/auth-navigation';

type LoginPayload =
  | {
      accessToken: string;
      user: unknown;
    }
  | {
      mfaRequired: true;
      challengeToken: string;
      email: string;
      expiresAt: string;
      availableMethods: readonly string[];
      allowRememberDevice?: boolean;
      attemptsRemaining?: number;
    };

export function LoginPage() {
  const nav = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const functionalCookiesEnabled = useCookieConsentStore((state) => state.preferences.functional);
  const [step, setStep] = useState<'credentials' | 'mfa'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [backupCode, setBackupCode] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [challengeExpiry, setChallengeExpiry] = useState('');
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(true);
  const [err, setErr] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!functionalCookiesEnabled) {
      setRememberDevice(false);
    }
  }, [functionalCookiesEnabled]);

  const steps = [
    { id: 'credentials', label: 'Credentials' },
    { id: 'mfa', label: 'Verify' },
  ];

  async function finalizeSignIn(payload: unknown) {
    setIsOpening(true);
    try {
      await initializeSessionFromAuthResponse(payload, queryClient);
      const signedInUser = useAuthStore.getState().user;
      const from = (location.state as { from?: string } | null)?.from ?? new URLSearchParams(location.search).get('returnTo');
      setPassword('');
      nav(signInDestination(from, dashboardHomePath(signedInUser?.role)), { replace: true });
    } catch (error) { setIsOpening(false); throw error; }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErr('');

    try {
      const res = await api.post('/auth/login', { email: email.trim(), password });
      const payload = (res.data?.data ?? res.data) as LoginPayload;
      if ('mfaRequired' in payload && payload.mfaRequired) {
        setChallengeToken(payload.challengeToken);
        setChallengeExpiry(payload.expiresAt);
        setAttemptsRemaining(payload.attemptsRemaining ?? null);
        setStep('mfa');
        setOtpCode('');
        setBackupCode('');
        setUseBackupCode(false);
        setRememberDevice(Boolean(payload.allowRememberDevice ?? true) && functionalCookiesEnabled);
        return;
      }
      await finalizeSignIn(res.data);
    } catch (error) {
      setErr(getApiErrorMessage(error, 'Login failed.'));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function onVerifyMfa(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErr('');

    try {
      const res = await api.post('/auth/mfa/login/verify', {
        challengeToken,
        code: useBackupCode ? undefined : otpCode.trim(),
        backupCode: useBackupCode ? backupCode.trim() : undefined,
        rememberDevice: useBackupCode ? false : functionalCookiesEnabled && rememberDevice,
      });
      await finalizeSignIn(res.data);
    } catch (error) {
      setErr(getApiErrorMessage(error, 'Could not verify your authenticator step.'));
    } finally {
      setIsSubmitting(false);
    }
  }

  const sessionExpired = new URLSearchParams(location.search).get('reason') === 'session-expired';
  return <AuthLayout>
    <div className="auth-form-heading">
      <span className="auth-eyebrow">{step === 'credentials' ? 'WELCOME BACK' : 'ONE MORE STEP'}</span>
      <h2>{step === 'credentials' ? 'Sign in to your workspace' : 'Verify your sign-in'}</h2>
      <p>{step === 'credentials' ? 'Enter your work email and password to continue.' : useBackupCode ? 'Use one of your single-use backup codes.' : 'Enter the code from your authenticator app.'}</p>
    </div>
    {sessionExpired && <p className="auth-notice" role="status">Your session has expired. Sign in again to continue where you left off.</p>}
    {step === 'mfa' && <AuthStepIndicator steps={steps} current={step} />}
    {step === 'credentials' ? (
              <form onSubmit={onSubmit} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      required
                      autoFocus
                      aria-invalid={!!err}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="username"
                      className="h-12 rounded-xl bg-muted pl-10"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="password"
                      required
                      minLength={8}
                      aria-invalid={!!err}
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                      className="h-12 rounded-xl bg-muted pl-10 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((visible) => !visible)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="flex justify-end">
                  <Link to="/forgot-password" className="text-sm font-medium text-primary hover:underline">
                    Forgot password?
                  </Link>
                </div>

                {err ? (
                  <div role="alert" className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
                    {err}
                  </div>
                ) : null}

                <Button className="h-12 w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/90" type="submit" loading={isSubmitting || isOpening} disabled={isSubmitting || isOpening}>
                  {isSubmitting ? 'Signing in...' : 'Sign in'}
                </Button>

                <p className="text-center text-sm text-muted-foreground">
                  New to SoftdigitIMS?{' '}
                  <Link to="/signup" className="font-medium text-primary hover:underline">
                    Create an account
                  </Link>
                </p>
              </form>
            ) : (
              <form onSubmit={onVerifyMfa} className="space-y-5">
                <div className="rounded-2xl border border-border bg-muted p-5">
                  {!useBackupCode ? (
                    <>
                      <div className="mb-4 text-center">
                        <p className="text-sm font-medium text-foreground">Authenticator code</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          This code expires at {new Date(challengeExpiry).toLocaleTimeString()}.
                        </p>
                        {attemptsRemaining ? (
                          <p className="mt-1 text-xs font-medium text-muted-foreground">
                            {attemptsRemaining} attempt(s) before the challenge locks.
                          </p>
                        ) : null}
                      </div>
                      <OtpCodeInput value={otpCode} onChange={setOtpCode} hasError={!!err} autoFocus />
                    </>
                  ) : (
                    <div className="space-y-2">
                      <Label htmlFor="backup-code">Backup code</Label>
                      <div className="relative">
                        <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="backup-code"
                          value={backupCode}
                          onChange={(event) => setBackupCode(event.target.value.toUpperCase())}
                          placeholder="ABCD-EFGH"
                          className="h-12 rounded-xl bg-card pl-10 uppercase tracking-[0.18em]"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {!useBackupCode ? (
                  <label className="flex items-start gap-3 rounded-xl border border-border bg-muted px-4 py-3 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={rememberDevice}
                      disabled={!functionalCookiesEnabled}
                      onChange={(event) => setRememberDevice(event.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary/20"
                    />
                    <span>
                      <span className="block font-medium text-foreground">Remember this device for 7 days</span>
                      <span className="block text-xs text-muted-foreground">
                        {functionalCookiesEnabled
                          ? 'Skip the authenticator step on this browser for the next 7 days.'
                          : 'Enable functional cookies in Cookie Preferences to use this convenience feature.'}
                      </span>
                    </span>
                  </label>
                ) : null}

                <div className="flex items-center justify-between text-sm">
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline"
                    onClick={() => {
                      setUseBackupCode((current) => !current);
                      setErr('');
                      setRememberDevice(false);
                    }}
                  >
                    {useBackupCode ? 'Use authenticator app instead' : 'Use a backup code instead'}
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setStep('credentials');
                      setErr('');
                      setChallengeToken('');
                      setOtpCode('');
                      setBackupCode('');
                      setAttemptsRemaining(null);
                      setRememberDevice(true);
                    }}
                  >
                    Back
                  </button>
                </div>

                {err ? (
                  <div role="alert" className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
                    {err}
                  </div>
                ) : null}

                <Button className="h-12 w-full rounded-xl" type="submit" disabled={isSubmitting || isOpening}>
                  {isSubmitting ? 'Verifying...' : 'Verify and sign in'}
                </Button>
              </form>
            )}
    <div className="auth-security-note"><ShieldCheck size={15} /><span>Secure access to your business workspace</span></div>
  </AuthLayout>;
}
export default LoginPage;
