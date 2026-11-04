import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  isPlatformAdmin?: boolean;
};

type SessionState = {
  accessToken: string | null;
  user: AdminUser | null;
  setSession: (accessToken: string, user: AdminUser) => void;
  clear: () => void;
};

/**
 * Kept in sessionStorage: the admin session ends with the browser tab and is never
 * shared with the tenant app's persisted session.
 */
export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      accessToken: null,
      user: null,
      setSession: (accessToken, user) => set({ accessToken, user }),
      clear: () => set({ accessToken: null, user: null }),
    }),
    { name: 'softdigit-admin-session', storage: createJSONStorage(() => sessionStorage) },
  ),
);
