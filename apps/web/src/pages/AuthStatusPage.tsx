import { Link } from 'react-router-dom';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { ShieldAlert, Clock } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/authStore';
import { dashboardHomePath } from '@/lib/roles';

export function AuthStatusPage({ expired = false }: { expired?: boolean }) {
  const user = useAuthStore(state => state.user);
  const Icon = expired ? Clock : ShieldAlert;
  return <AuthLayout><div className="auth-form-heading"><Icon size={30} /><h2>{expired ? 'Your session has expired' : 'You don’t have access to this page'}</h2><p>{expired ? 'Sign in again to continue working. Your saved business records are still available.' : 'This page requires a different role or permission. Ask your workspace administrator if you need access.'}</p></div>
    <Button className="w-full" asChild><Link to={expired || !user ? '/login?reason=session-expired' : dashboardHomePath(user.role)}>{expired || !user ? 'Back to sign in' : 'Back to my workspace'}</Link></Button>
  </AuthLayout>;
}
