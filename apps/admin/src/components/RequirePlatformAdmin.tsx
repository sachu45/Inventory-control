import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '@/lib/session';

/**
 * UI gate only: every /platform API route is also behind PlatformAdminGuard on the
 * server, so a forged client flag gets nothing but 403s.
 */
export function RequirePlatformAdmin() {
  const { accessToken, user } = useSession();
  const location = useLocation();
  if (!accessToken || !user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!user.isPlatformAdmin) return <Navigate to="/access-denied" replace />;
  return <Outlet />;
}
