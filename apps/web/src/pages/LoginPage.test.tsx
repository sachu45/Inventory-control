import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginPage } from './LoginPage';
import { api } from '@/api/client';
import { initializeSessionFromAuthResponse } from '@/lib/session';
import { useAuthStore } from '@/store/authStore';

vi.mock('@/api/client', () => ({ api: { post: vi.fn() } }));
vi.mock('@/lib/session', () => ({ initializeSessionFromAuthResponse: vi.fn() }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id:'owner', email:'owner@example.test', name:'Owner', role:'OWNER', shopId:null, permissions:[] } });
  vi.mocked(initializeSessionFromAuthResponse).mockResolvedValue(undefined as never);
});
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry:false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[{ pathname:'/login', state:{ from:'/products' } }]}><Routes><Route path="/login" element={<LoginPage />} /><Route path="/products" element={<p>Workspace ready</p>} /></Routes></MemoryRouter></QueryClientProvider>);
  return userEvent.setup();
}
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'owner@example.test');
  await user.type(screen.getByLabelText('Password'), 'test-password-123');
}
describe('enterprise login integration', () => {
  it('validates required fields before calling the API', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name:'Sign in' }));
    expect(api.post).not.toHaveBeenCalled();
  });
  it('uses the existing login endpoint and returns to the requested page', async () => {
    vi.mocked(api.post).mockResolvedValue({ data:{ data:{ accessToken:'test-token', user:{ id:'owner' } } } });
    const user = setup(); await fill(user);
    await user.click(screen.getByRole('button', { name:'Sign in' }));
    await screen.findByText('Workspace ready');
    expect(api.post).toHaveBeenCalledWith('/auth/login', { email:'owner@example.test', password:'test-password-123' });
    expect(initializeSessionFromAuthResponse).toHaveBeenCalledTimes(1);
  });
  it('shows invalid credentials without creating a session', async () => {
    vi.mocked(api.post).mockRejectedValue({ response:{ status:401, data:{ message:'Invalid credentials' } } });
    const user = setup(); await fill(user);
    await user.click(screen.getByRole('button', { name:'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
    expect(initializeSessionFromAuthResponse).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name:'Sign in' })).toBeEnabled();
  });
  it('waits for MFA verification before issuing the frontend session', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data:{ data:{ mfaRequired:true, challengeToken:'challenge', email:'owner@example.test', expiresAt:new Date(Date.now()+60000).toISOString(), availableMethods:['TOTP'], allowRememberDevice:false } } }).mockResolvedValueOnce({ data:{ data:{ accessToken:'test-token', user:{ id:'owner' } } } });
    const user = setup(); await fill(user);
    await user.click(screen.getByRole('button', { name:'Sign in' }));
    const code = await screen.findByLabelText('Verification code digit 1 of 6');
    expect(initializeSessionFromAuthResponse).not.toHaveBeenCalled();
    await user.click(code); await user.paste('123456');
    await user.click(screen.getByRole('button', { name:'Verify and sign in' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/mfa/login/verify', expect.objectContaining({ challengeToken:'challenge', code:'123456' })));
    await screen.findByText('Workspace ready');
  });
});
