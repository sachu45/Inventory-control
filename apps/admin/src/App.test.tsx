import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { authApi, platformApi, type TenantDetail, type TenantPage } from './lib/platform-api';
import { useSession } from './lib/session';

const admin = { id: 'u1', name: 'Admin', email: 'admin@example.com', isPlatformAdmin: true };
const tenantPage: TenantPage = {
  items: [
    {
      id: 'c1',
      companyCode: 'ACME',
      companyName: 'Acme Retail',
      isActive: true,
      subscriptionPlan: 'PLUS',
      subscriptionStatus: 'ACTIVE',
      createdAt: '2026-10-01T00:00:00.000Z',
      activeConfig: { version: 3, publishedAt: '2026-11-01T00:00:00.000Z' },
    },
  ],
  meta: { nextCursor: null, limit: 25, hasMore: false },
};
const tenantDetail: TenantDetail = {
  id: 'c1',
  companyCode: 'ACME',
  companyName: 'Acme Retail',
  isActive: true,
  subscriptionPlan: 'PLUS',
  subscriptionStatus: 'ACTIVE',
  shops: [{ id: 's1', shopNumber: 'HQ-001', shopName: 'Head Office', isActive: true }],
  activeConfig: { version: 3, publishedAt: '2026-11-01T00:00:00.000Z', publishedBy: 'u1' },
  draftCount: 2,
};

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('admin app', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSession.getState().clear();
  });

  it('sends signed-out visitors to the login page', () => {
    renderAt('/tenants');
    expect(screen.getByRole('heading', { name: 'Platform Admin' })).toBeInTheDocument();
  });

  it('shows access denied to a signed-in non-admin', () => {
    useSession.getState().setSession('t', { ...admin, isPlatformAdmin: false });
    renderAt('/tenants');
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
  });

  it('logs a platform admin in, then lists tenants and opens one', async () => {
    vi.spyOn(authApi, 'login').mockResolvedValue({ kind: 'session', accessToken: 'tok', user: admin });
    vi.spyOn(platformApi, 'listTenants').mockResolvedValue(tenantPage);
    vi.spyOn(platformApi, 'getTenant').mockResolvedValue(tenantDetail);
    const user = userEvent.setup();
    renderAt('/tenants');

    await user.type(screen.getByLabelText('Email'), 'admin@example.com');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('link', { name: 'Acme Retail' })).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(useSession.getState().accessToken).toBe('tok');

    await user.click(screen.getByRole('link', { name: 'Acme Retail' }));
    expect(await screen.findByRole('heading', { name: 'Acme Retail' })).toBeInTheDocument();
    expect(screen.getByText('Head Office')).toBeInTheDocument();
    expect(platformApi.getTenant).toHaveBeenCalledWith('c1');
  });

  it('asks for the MFA code when the account has two-factor auth', async () => {
    vi.spyOn(authApi, 'login').mockResolvedValue({ kind: 'mfa', challengeToken: 'ch1' });
    const verify = vi.spyOn(authApi, 'verifyMfa').mockResolvedValue({ kind: 'session', accessToken: 'tok', user: admin });
    vi.spyOn(platformApi, 'listTenants').mockResolvedValue(tenantPage);
    const user = userEvent.setup();
    renderAt('/login');

    await user.type(screen.getByLabelText('Email'), 'admin@example.com');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.type(await screen.findByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(verify).toHaveBeenCalledWith('ch1', '123456');
    await waitFor(() => expect(useSession.getState().accessToken).toBe('tok'));
  });

  it('searches tenants by the typed text', async () => {
    useSession.getState().setSession('tok', admin);
    const list = vi.spyOn(platformApi, 'listTenants').mockResolvedValue(tenantPage);
    const user = userEvent.setup();
    renderAt('/tenants');
    await screen.findByRole('link', { name: 'Acme Retail' });

    await user.type(screen.getByLabelText('Search tenants'), 'acme');
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ search: 'acme', cursor: undefined }));
  });
});
