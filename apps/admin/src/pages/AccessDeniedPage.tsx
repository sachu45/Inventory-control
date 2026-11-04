import { useNavigate } from 'react-router-dom';
import { useSession } from '@/lib/session';

export function AccessDeniedPage() {
  const { user, clear } = useSession();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="text-sm text-slate-600">
          {user?.email ?? 'This account'} is not a platform administrator. Platform admin access is granted only by the
          operations team.
        </p>
        <button
          type="button"
          onClick={() => {
            clear();
            navigate('/login', { replace: true });
          }}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          Sign in with another account
        </button>
      </div>
    </div>
  );
}
