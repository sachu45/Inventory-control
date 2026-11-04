import axios, { AxiosError } from 'axios';
import { useSession } from './session';

export const api = axios.create({ baseURL: '/api/v1' });

api.interceptors.request.use((config) => {
  const token = useSession.getState().accessToken;
  if (token) config.headers.set('Authorization', `Bearer ${token}`);
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    // Expired or revoked token: drop the session so the router sends the admin to login.
    if (error.response?.status === 401 && !error.config?.url?.startsWith('/auth/')) {
      useSession.getState().clear();
    }
    return Promise.reject(error);
  },
);

type Envelope<T> = { success?: boolean; data: T };

/** The API wraps every success body as `{ success, data, meta }`. */
export function unwrap<T>(body: Envelope<T> | T): T {
  if (body && typeof body === 'object' && 'data' in body && 'success' in body) {
    return (body as Envelope<T>).data;
  }
  return body as T;
}

/** The API's error envelope is `{ success: false, error: { code, message, details } }`. */
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as { error?: { message?: string } } | undefined;
    if (body?.error?.message) return body.error.message;
    if (!error.response) return 'Cannot reach the API. Is it running on port 3000?';
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}
