import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchMeConfig, type MeConfig } from '@/api/me-config';
import { useAuthStore } from '@/store/authStore';

/**
 * Keeps `authStore.meConfig` in step with `GET /me/config` for the signed-in user.
 * Mount once in the app shell; navigation reads the store. Revalidation sends the
 * stored ETag, so an unchanged config costs a `304`. On failure the stored config
 * is dropped and navigation falls back to the built-in sidebar and permission gates.
 */
export function useMeConfigSync() {
  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);
  const setMeConfig = useAuthStore((s) => s.setMeConfig);
  // Platform-wide users have no company, so there is no tenant config to load.
  const enabled = Boolean(accessToken && user?.id && user.companyId);

  const query = useQuery({
    queryKey: ['me-config', user?.id],
    queryFn: () => fetchMeConfig(user!.id, useAuthStore.getState().meConfig),
    enabled,
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (query.data) setMeConfig(query.data);
  }, [query.data, setMeConfig]);

  useEffect(() => {
    if (query.isError) setMeConfig(null);
  }, [query.isError, setMeConfig]);

  useEffect(() => {
    const stored = useAuthStore.getState().meConfig;
    if (stored && (!enabled || stored.userId !== user?.id)) setMeConfig(null);
  }, [enabled, user?.id, setMeConfig]);
}

/** The current user's `/me/config`, or null to use the built-in sidebar. */
export function useMeConfig(): MeConfig | null {
  return useAuthStore((s) => (s.meConfig && s.meConfig.userId === s.user?.id ? s.meConfig.data : null));
}
