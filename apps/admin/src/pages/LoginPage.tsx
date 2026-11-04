import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { errorMessage } from '@/lib/api';
import { authApi, type LoginResult } from '@/lib/platform-api';
import { useSession } from '@/lib/session';

const input = 'w-full rounded-md border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none';

export function LoginPage() {
  const { accessToken, user, setSession } = useSession();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/tenants';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (accessToken && user) return <Navigate to={user.isPlatformAdmin ? from : '/access-denied'} replace />;

  const handle = (result: LoginResult) => {
    if (result.kind === 'session') {
      setSession(result.accessToken, result.user);
      navigate(result.user.isPlatformAdmin ? from : '/access-denied', { replace: true });
    } else if (result.kind === 'mfa') {
      setChallengeToken(result.challengeToken);
    } else {
      setError('This account must finish setting up two-factor authentication in the main app first.');
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      handle(challengeToken ? await authApi.verifyMfa(challengeToken, code.trim()) : await authApi.login(email.trim(), password));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Platform Admin</h1>
          <p className="text-sm text-slate-500">
            {challengeToken ? 'Enter the code from your authenticator app.' : 'Sign in with your SoftDigit account.'}
          </p>
        </div>
        {challengeToken ? (
          <label className="block space-y-1 text-sm">
            <span>Authentication code</span>
            <input className={input} inputMode="numeric" autoComplete="one-time-code" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        ) : (
          <>
            <label className="block space-y-1 text-sm">
              <span>Email</span>
              <input className={input} type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="block space-y-1 text-sm">
              <span>Password</span>
              <input className={input} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="w-full rounded-md bg-slate-900 px-3 py-2 font-medium text-white hover:bg-slate-800 disabled:opacity-60">
          {busy ? 'Signing in…' : challengeToken ? 'Verify' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
