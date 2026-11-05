import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { BackupCodesCard } from '@/components/auth/BackupCodesCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ShieldCheck } from '@/components/ui/icons';
import { api } from '@/api/client';
import { startGoogleOnboarding } from '@/lib/google-onboarding';
import { getApiErrorMessage } from '@/lib/api-error';
import { initializeSessionFromAuthResponse } from '@/lib/session';
import { useRazorpayCheckout } from '@/hooks/use-razorpay-checkout';

type Onboarding = {
  status: string; loginOnly: boolean; plan: 'pro' | 'plus'; billing: 'monthly' | 'yearly'; amountPaise: number; taxPaise: number;
  user: { name: string; email: string; picture: string | null } | null;
  linkRequired: boolean; securityRequired: boolean; mfaEnabled: boolean; workspaceReady: boolean;
};
type SecuritySetup = { challengeToken: string; manualCode?: string; qrCodeDataUrl?: string };
const unwrap = <T,>(response: { data: { data?: T } | T }): T => ((response.data as { data?: T }).data ?? response.data) as T;

export function GoogleOnboardingPage() {
  const location = useLocation();
  const [params] = useSearchParams();
  const continuing = location.pathname.endsWith('/continue');
  const loginOnly = params.get('mode') === 'login';
  const plan = params.get('plan') === 'plus' ? 'plus' : 'pro';
  const billing = params.get('billing') === 'yearly' ? 'yearly' : 'monthly';
  const [snapshot, setSnapshot] = useState<Onboarding | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [terms, setTerms] = useState(false);
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<SecuritySetup | null>(null);
  const [code, setCode] = useState('');
  const [backupCode, setBackupCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const started = useRef(false);
  const { checkout, loading: paying } = useRazorpayCheckout();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function reload() {
    const state = unwrap<Onboarding>(await api.get('/auth/onboarding/session'));
    setSnapshot(state);
  }
  async function action(message: string, work: () => Promise<void>) {
    setBusy(message); setError('');
    try { await work(); } catch (err) { setError(getApiErrorMessage(err, err instanceof Error ? err.message : 'Please try again.')); }
    finally { setBusy(''); }
  }
  async function begin() {
    await action('Redirecting to Google…', () => startGoogleOnboarding(loginOnly ? { loginOnly: true } : { plan, billing }));
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!continuing) { void begin(); return; }
    const failure = params.get('error');
    if (failure) { setError(failure === 'cancelled' ? 'Google sign-in was cancelled. Choose a plan to try again.' : 'This Google transaction is invalid, expired or was already used. Start again.'); return; }
    void action('Preparing your account…', reload);
    // Run once for this page mount: repeated renders must not create OAuth intents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finish() {
    await action('Opening your workspace…', async () => {
      const response = await api.post('/auth/onboarding/finish');
      await initializeSessionFromAuthResponse(response.data, queryClient);
      navigate('/dashboard', { replace: true });
    });
  }
  async function pay() {
    if (!snapshot) return;
    await action('Preparing checkout…', async () => {
      await checkout({ plan: snapshot.plan, billing: snapshot.billing, serverIntent: true,
        orderEndpoint: '/auth/onboarding/checkout', verifyEndpoint: '/auth/onboarding/payment/verify',
        prefill: { name: snapshot.user?.name, email: snapshot.user?.email },
        onSuccess: async () => { await reload(); await finish(); },
      });
    });
  }
  const disabled = !!busy || paying;
  const pricingHref = import.meta.env.DEV ? '/#pricing' : 'https://softdigitconsulting.com/#pricing';
  const step = !snapshot ? 'google' : snapshot.linkRequired ? 'link' : !snapshot.workspaceReady ? 'workspace' : snapshot.securityRequired ? 'security' : 'checkout';
  const amount = snapshot ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(snapshot.amountPaise / 100) : '';

  return <AuthLayout headline={'A simpler start.\nA secure workspace.'} description="Choose your plan, verify your Google account and name your workspace. Payment stays separate from sign-in.">
    <div className="auth-form-heading"><span className="auth-eyebrow">{loginOnly || snapshot?.loginOnly ? 'GOOGLE SIGN-IN' : 'GET STARTED'}</span>
      <h2>{!snapshot ? 'Continue with Google' : 'Your account is ready.'}</h2>
      <p>{!snapshot ? 'Google verifies your identity. We only request your name, email and profile picture.' : 'Complete the remaining steps to open your workspace.'}</p>
    </div>
    {snapshot?.user && <div className="my-5 flex items-center gap-3 rounded-lg border border-border p-3">
      {snapshot.user.picture ? <img src={snapshot.user.picture} alt="Google profile" referrerPolicy="no-referrer" className="h-10 w-10 rounded-full" /> : <ShieldCheck className="h-8 w-8 text-primary" />}
      <div className="min-w-0"><strong className="block text-sm">{snapshot.user.name}</strong><span className="block truncate text-xs text-muted-foreground">{snapshot.user.email} · Verified by Google</span></div>
    </div>}
    {(busy || paying) && <p role="status" className="auth-notice">{paying ? 'Complete the secure Razorpay checkout…' : busy}</p>}
    {error && <div role="alert" className="my-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"><p>{error}</p><div className="mt-2 flex gap-4"><a className="underline" href={pricingHref}>Choose a plan</a><Link className="underline" to="/login">Sign in</Link></div></div>}
    {!continuing && <><p className="mb-4 text-sm">{loginOnly ? 'Sign in to your linked workspace.' : `${plan.toUpperCase()} · ${billing} billing. No payment is taken during Google sign-in.`}</p><Button disabled={disabled} className="w-full" onClick={begin}>Continue with Google</Button><p className="mt-4 text-xs text-muted-foreground">Read our <Link className="underline" to="/terms">Terms</Link> and <Link className="underline" to="/privacy">Privacy Policy</Link>. You will review workspace terms before checkout.</p></>}
    {snapshot && step === 'link' && <form onSubmit={event => { event.preventDefault(); void action('Verifying your existing account…', async () => { await api.post('/auth/onboarding/link', { password }); setPassword(''); await reload(); }); }} className="space-y-4">
      <p className="text-sm">An account already uses this email. Enter its existing password to link Google securely. Your current MFA protection still applies.</p>
      <Label htmlFor="existing-password">Existing account password</Label><Input id="existing-password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} />
      <Button disabled={disabled} type="submit">Verify and link account</Button><Link className="ml-4 text-sm underline" to="/forgot-password">Recover account</Link>
    </form>}
    {snapshot && step === 'workspace' && <form className="space-y-4" onSubmit={event => { event.preventDefault(); void action('Preparing your workspace…', async () => { await api.post('/auth/onboarding/workspace', { workspaceName, companyName: companyName || undefined, agreedToTerms: terms }); await reload(); }); }}>
      <div><Label htmlFor="workspace-name">Workspace name</Label><Input id="workspace-name" placeholder="e.g. Central warehouse" required minLength={2} maxLength={100} value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} /></div>
      <div><Label htmlFor="company-name">Company name <span className="text-muted-foreground">(optional)</span></Label><Input id="company-name" maxLength={150} value={companyName} onChange={event => setCompanyName(event.target.value)} /></div>
      <p className="text-xs text-muted-foreground">Add addresses, tax details and other business information later in Settings.</p>
      <label className="flex gap-2 text-xs"><input type="checkbox" required checked={terms} onChange={event => setTerms(event.target.checked)} /><span>I agree to the <Link className="underline" to="/terms" target="_blank">Terms of Service</Link> and <Link className="underline" to="/privacy" target="_blank">Privacy Policy</Link>.</span></label>
      <Button type="submit" disabled={disabled || !terms || workspaceName.trim().length < 2}>Create workspace</Button>
    </form>}
    {snapshot && step === 'security' && !codes.length && <section className="space-y-4"><h3 className="font-semibold">{snapshot.mfaEnabled ? 'Verify your authenticator' : 'Protect your administrator account'}</h3>
      <p className="text-sm text-muted-foreground">{snapshot.mfaEnabled ? 'Use your authenticator or one unused backup code.' : 'Administrator accounts need an authenticator. Scan the code and save your backup codes. Other security settings remain available in your profile.'}</p>
      {!setup ? <Button disabled={disabled} onClick={() => void action('Preparing security verification…', async () => { setSetup(unwrap<SecuritySetup>(await api.post('/auth/onboarding/security/start'))); })}>{snapshot.mfaEnabled ? 'Verify account' : 'Set up authenticator'}</Button> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); void action('Verifying security code…', async () => { const result = unwrap<{ backupCodes?: string[] }>(await api.post('/auth/onboarding/security/verify', { token: setup.challengeToken, code: code || undefined, backupCode: backupCode || undefined })); setCode(''); setBackupCode(''); if (result.backupCodes?.length) setCodes(result.backupCodes); else await reload(); }); }}>
        {setup.qrCodeDataUrl && <img className="h-44 w-44" src={setup.qrCodeDataUrl} alt="Scan with your authenticator app" />}
        {setup.manualCode && <details><summary className="text-sm">Enter a setup key instead</summary><code className="break-all text-sm">{setup.manualCode}</code></details>}
        <Label htmlFor="authenticator-code">Authenticator code</Label><Input id="authenticator-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value)} />
        {snapshot.mfaEnabled && <><Label htmlFor="backup-code">Or a backup code</Label><Input id="backup-code" value={backupCode} onChange={event => setBackupCode(event.target.value)} /></>}
        <Button disabled={disabled || (!code && !backupCode)} type="submit">Verify code</Button><button className="ml-3 text-sm underline" type="button" onClick={() => { setSetup(null); setCode(''); setBackupCode(''); }}>Restart verification</button>
      </form>}
    </section>}
    {!!codes.length && <><BackupCodesCard codes={codes} /><Button className="mt-4" onClick={() => void action('Preparing checkout…', async () => { setCodes([]); setSetup(null); await reload(); })}>I saved my backup codes</Button></>}
    {snapshot && step === 'checkout' && (snapshot.loginOnly ? <Button className="w-full" disabled={disabled} onClick={finish}>Open workspace</Button> : <section className="space-y-4">
      <h3 className="font-semibold">{snapshot.status === 'SUBSCRIPTION_ACTIVE' ? 'Subscription activated' : 'Review your subscription'}</h3>
      <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border p-4 text-sm"><dt>Plan</dt><dd>{snapshot.plan.toUpperCase()}</dd><dt>Billing interval</dt><dd>{snapshot.billing}</dd><dt>Total</dt><dd>{amount}</dd><dt>Additional tax</dt><dd>{snapshot.taxPaise === 0 ? '₹0 under current pricing' : snapshot.taxPaise / 100}</dd><dt>Payment method</dt><dd>Razorpay secure checkout</dd></dl>
      <p className="text-xs text-muted-foreground">One payment covers one {snapshot.billing === 'yearly' ? 'year' : 'month'}. Renewal is manual; Google sign-in never charges you. Paid access starts only after backend payment verification.</p>
      {snapshot.status === 'SUBSCRIPTION_ACTIVE' ? <Button disabled={disabled} onClick={finish}>Start using the ERP</Button> : <><Button disabled={disabled} onClick={pay}>Continue to payment · {amount}</Button><button className="block text-sm underline" disabled={disabled} onClick={() => void action('Checking payment status…', reload)}>Already paid? Check activation</button></>}
    </section>)}
    {continuing && !snapshot && !busy && !error && <Button onClick={() => void action('Loading onboarding…', reload)}>Reload onboarding</Button>}
    {snapshot && <button type="button" disabled={disabled} className="mt-5 text-xs text-muted-foreground underline" onClick={() => void action('Closing onboarding…', async () => { await api.post('/auth/onboarding/cancel'); navigate('/'); })}>Leave onboarding</button>}
  </AuthLayout>;
}
