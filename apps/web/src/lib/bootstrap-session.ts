import { api, applyAccessToken, isSessionRejected, refreshRequestOnce } from '@/api/client';
import { initializeSessionFromAuthResponse } from '@/lib/session';
import { useAuthStore, type AuthUser } from '@/store/authStore';

/** Validate restored identity before rendering protected routes. */
export async function bootstrapSession() {
  const tokenAtStart = useAuthStore.getState().accessToken;
  const hasStoredSession = Boolean(tokenAtStart || window.localStorage.getItem('retail-ims-auth-state'));
  useAuthStore.getState().setInitialized(false);
  applyAccessToken(tokenAtStart);
  try {
    if (!hasStoredSession) return;
    if (tokenAtStart) {
      // A valid bearer token needs no cookie rotation. The existing interceptor
      // refreshes an expired token once and retries /auth/me if necessary.
      const response = await api.get('/auth/me');
      const user = (response.data?.data ?? response.data) as AuthUser;
      const current = useAuthStore.getState();
      if (current.accessToken && current.user?.id === user.id) current.setUser(user);
    } else {
      const response = await refreshRequestOnce();
      await initializeSessionFromAuthResponse(response.data);
    }
  } catch (error) {
    const currentToken = useAuthStore.getState().accessToken;
    // A concurrent successful sign-in wins. Temporary outages retain the cached
    // session; rejected credentials are cleared without granting new access.
    if (isSessionRejected(error) && (!currentToken || currentToken === tokenAtStart)) {
      applyAccessToken(null);
      useAuthStore.getState().clear();
    }
  } finally {
    useAuthStore.getState().setInitialized(true);
  }
}
