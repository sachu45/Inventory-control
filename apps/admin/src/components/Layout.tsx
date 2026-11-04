import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '@/lib/session';

export function Layout() {
  const user = useSession((s) => s.user);
  const clear = useSession((s) => s.clear);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const signOut = () => {
    clear();
    queryClient.clear();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link to="/tenants" className="font-semibold tracking-tight">
            SoftDigit <span className="text-slate-500">Platform Admin</span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-slate-600">{user?.email}</span>
            <button type="button" onClick={signOut} className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
