import { api } from '@/api/client';

/** One sidebar entry from `GET /me/config`; already filtered by plan, permission and config. */
export type MeSidebarLink = {
  key: string;
  label: string;
  path: string;
  /** Key in `menuIcons`. */
  icon: string;
  /** Plan does not include it; shown and gated on the page, as before. */
  locked: boolean;
};

export type MeSidebarSection = { id: string; title: string; children: MeSidebarLink[] };

export type MeUserPreferences = {
  columnOrder?: string[];
  hiddenColumns?: string[];
  defaultSort?: { field: string; direction: 'asc' | 'desc' };
  defaultFilters?: Record<string, unknown>;
  pinned?: string[];
  order?: string[];
};

export type MeConfig = {
  version: number;
  modules: Record<string, { usable: boolean; label: string; config: { mandatoryFields: string[]; hiddenFields: string[]; label?: string } }>;
  sidebar: MeSidebarSection[];
  preferences: Record<string, MeUserPreferences>;
};

export type CachedMeConfig = { userId: string; etag: string | null; data: MeConfig };

function isMeConfig(value: unknown): value is MeConfig {
  const v = value as Partial<MeConfig> | null;
  return !!v && typeof v === 'object' && Array.isArray(v.sidebar) && typeof v.modules === 'object' && v.modules !== null;
}

/**
 * Loads `/me/config`, revalidating with the ETag of `previous` when it belongs to
 * the same user. A `304` keeps `previous`; anything unusable throws so the caller
 * falls back to the built-in sidebar.
 */
export async function fetchMeConfig(userId: string, previous: CachedMeConfig | null): Promise<CachedMeConfig> {
  const cached = previous?.userId === userId ? previous : null;
  const res = await api.get('/me/config', {
    headers: cached?.etag ? { 'If-None-Match': cached.etag } : undefined,
    validateStatus: (status) => status === 200 || status === 304,
  });
  if (res.status === 304 && cached) return cached;
  const body = res.data as { data?: unknown } | undefined;
  const data = body && typeof body === 'object' && 'data' in body ? body.data : body;
  if (!isMeConfig(data)) throw new Error('Unexpected /me/config response');
  const etag = res.headers?.etag;
  return { userId, etag: typeof etag === 'string' ? etag : null, data };
}
