import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapSession } from './bootstrap-session';
import { api, applyAccessToken, refreshRequestOnce } from '@/api/client';
import { initializeSessionFromAuthResponse } from '@/lib/session';
import { useAuthStore, type AuthUser } from '@/store/authStore';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn() }, applyAccessToken: vi.fn(), refreshRequestOnce: vi.fn(),
  isSessionRejected: (error: { response?: { status?: number } }) => [401,403].includes(error.response?.status ?? 0),
}));
vi.mock('@/lib/session', () => ({ initializeSessionFromAuthResponse: vi.fn() }));
const user: AuthUser = { id:'owner', name:'Owner', email:'owner@example.test', role:'OWNER', permissions:[], shopId:null };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  useAuthStore.setState({ user:null, accessToken:null, initialized:false });
  localStorage.clear();
});
describe('session startup validation', () => {
  it('does not refresh a first-time visitor', async () => {
    await bootstrapSession();
    expect(api.get).not.toHaveBeenCalled(); expect(refreshRequestOnce).not.toHaveBeenCalled();
    expect(useAuthStore.getState().initialized).toBe(true);
  });
  it('gates protected pages and validates a cached token without rotating its cookie', async () => {
    useAuthStore.getState().setSession('cached', user);
    let finish!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = bootstrapSession();
    expect(useAuthStore.getState().initialized).toBe(false);
    finish({ data:{ data:{ ...user, name:'Updated owner' } } }); await pending;
    expect(api.get).toHaveBeenCalledWith('/auth/me'); expect(refreshRequestOnce).not.toHaveBeenCalled();
    expect(applyAccessToken).toHaveBeenCalledWith('cached');
    expect(useAuthStore.getState().user?.name).toBe('Updated owner');
    expect(useAuthStore.getState().initialized).toBe(true);
  });
  it('uses the existing refresh initialization when only a previous session marker remains', async () => {
    localStorage.setItem('retail-ims-auth-state', '{}');
    vi.mocked(refreshRequestOnce).mockResolvedValueOnce({ data:{ accessToken:'refreshed', user } } as never);
    await bootstrapSession();
    expect(initializeSessionFromAuthResponse).toHaveBeenCalledWith({ accessToken:'refreshed', user });
  });
  it('clears rejected cached credentials', async () => {
    useAuthStore.getState().setSession('expired', user);
    vi.mocked(api.get).mockRejectedValueOnce({ response:{ status:401 } });
    await bootstrapSession();
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
  it('retains the cached session during a server outage', async () => {
    useAuthStore.getState().setSession('cached', user);
    vi.mocked(api.get).mockRejectedValueOnce({ response:{ status:503 } });
    await bootstrapSession();
    expect(useAuthStore.getState().accessToken).toBe('cached');
  });
  it('does not erase a newer sign-in when an older startup request fails', async () => {
    useAuthStore.getState().setSession('old', user);
    vi.mocked(api.get).mockImplementationOnce(async () => {
      useAuthStore.getState().setSession('new-login', user);
      throw { response:{ status:401 } };
    });
    await bootstrapSession();
    expect(useAuthStore.getState().accessToken).toBe('new-login');
  });
});
