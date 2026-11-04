import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MeConfig, ModuleBlock } from '@/api/me-config';
import { moduleKeyForPath } from '@/lib/module-routes';
import type { SubscriptionSnapshot } from '@/lib/plans';
import { useAuthStore, type AuthUser } from '@/store/authStore';
import { FeatureGate } from './FeatureGate';
import { TrialFeatureGate } from './TrialFeatureGate';

const user: AuthUser = { id: 'u1', email: 'u@example.com', name: 'U', role: 'OWNER', shopId: null, companyId: 'c1', permissions: [] };
const trial = (features: Record<string, boolean> = {}) => ({ plan: 'TRIAL', features }) as unknown as SubscriptionSnapshot;
const pro = { plan: 'PRO', features: {} } as unknown as SubscriptionSnapshot;

function withConfig(modules: Record<string, ModuleBlock | null>, role = 'OWNER') {
  const data: MeConfig = {
    version: 3,
    modules: Object.fromEntries(
      Object.entries(modules).map(([key, blockedBy]) => [
        key,
        { usable: blockedBy === null, blockedBy, label: key === 'contracts' ? 'Agreements' : key, config: { mandatoryFields: [], hiddenFields: [] } },
      ]),
    ),
    sidebar: [],
    preferences: {},
  };
  useAuthStore.getState().setSession('tok', { ...user, role });
  useAuthStore.getState().setMeConfig({ userId: user.id, etag: null, data });
}

const page = <p>Module page</p>;
const renderGate = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('FeatureGate', () => {
  beforeEach(() => {
    useAuthStore.getState().clear();
    useAuthStore.getState().setSession('tok', user);
  });

  describe('plan gating, exactly as before', () => {
    it('shows the upgrade prompt on TRIAL without the feature flag', () => {
      renderGate(<FeatureGate subscription={trial()} feature="purchaseOrders">{page}</FeatureGate>);
      expect(screen.getByText('Upgrade to access this feature')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Go to Upgrade' })).toHaveAttribute('href', '/upgrade');
      expect(screen.queryByText('Module page')).not.toBeInTheDocument();
    });

    it('lets TRIAL through when the flag is on, and paid plans and unknown subscriptions always', () => {
      for (const subscription of [trial({ purchaseOrders: true }), pro, null, undefined]) {
        const { unmount } = renderGate(<FeatureGate subscription={subscription} feature="purchaseOrders">{page}</FeatureGate>);
        expect(screen.getByText('Module page')).toBeInTheDocument();
        unmount();
      }
    });

    it('keeps the plan prompt when the config also disables the module', () => {
      withConfig({ 'purchase-orders': 'config' });
      renderGate(<FeatureGate subscription={trial()} feature="purchaseOrders">{page}</FeatureGate>);
      expect(screen.getByText('Upgrade to access this feature')).toBeInTheDocument();
    });
  });

  describe('modules disabled by the organisation config', () => {
    it('shows "not enabled" with no upgrade prompt', () => {
      withConfig({ contracts: 'config' });
      renderGate(<FeatureGate subscription={pro} feature="contracts">{page}</FeatureGate>);
      expect(screen.getByText('This module is not enabled for your organisation')).toBeInTheDocument();
      expect(screen.getByText(/Agreements has been switched off/)).toBeInTheDocument();
      expect(screen.queryByText('Go to Upgrade')).not.toBeInTheDocument();
      expect(screen.queryByText('Module page')).not.toBeInTheDocument();
    });

    it('gates modules with no plan feature by module key', () => {
      withConfig({ 'eway-bills': 'config' });
      renderGate(<FeatureGate module="eway-bills">{page}</FeatureGate>);
      expect(screen.getByText('This module is not enabled for your organisation')).toBeInTheDocument();
    });

    it('links to the role home page, or the tools hub when home is the disabled module', () => {
      withConfig({ contracts: 'config' }, 'OWNER');
      const { unmount } = renderGate(<FeatureGate module="contracts">{page}</FeatureGate>);
      expect(screen.getByRole('link', { name: 'Go to your home page' })).toHaveAttribute('href', '/dashboard');
      unmount();

      withConfig({ 'purchase-orders': 'config' }, 'PURCHASE_MANAGER');
      renderGate(<FeatureGate module="purchase-orders">{page}</FeatureGate>);
      expect(screen.getByRole('link', { name: 'Go to your home page' })).toHaveAttribute('href', '/tools');
    });
  });

  it('leaves everything else to existing checks: usable, permission, role, plan-by-config, no config loaded', () => {
    for (const blockedBy of [null, 'permission', 'role', 'plan'] as const) {
      withConfig({ contracts: blockedBy });
      const { unmount } = renderGate(<FeatureGate subscription={pro} module="contracts">{page}</FeatureGate>);
      expect(screen.getByText('Module page')).toBeInTheDocument();
      unmount();
    }
    useAuthStore.getState().setMeConfig(null);
    renderGate(<FeatureGate module="contracts">{page}</FeatureGate>);
    expect(screen.getByText('Module page')).toBeInTheDocument();
  });

  it('TrialFeatureGate is the same component, so existing usages are unchanged', () => {
    expect(TrialFeatureGate).toBe(FeatureGate);
    withConfig({ invoices: 'config' });
    renderGate(<TrialFeatureGate subscription={pro} feature="invoices">{page}</TrialFeatureGate>);
    expect(screen.getByText('This module is not enabled for your organisation')).toBeInTheDocument();
  });
});

describe('moduleKeyForPath', () => {
  it('maps module pages, including nested and renamed paths', () => {
    expect(moduleKeyForPath('/purchase-orders')).toBe('purchase-orders');
    expect(moduleKeyForPath('/rfqs/abc/compare')).toBe('rfqs');
    expect(moduleKeyForPath('/quotations/new')).toBe('sales-quotations');
    expect(moduleKeyForPath('/sales/123')).toBe('sales');
  });

  it('ignores pages that are not modules', () => {
    for (const path of ['/', '/profile', '/help', '/tools', '/platform/subscriptions', '/workflow-engine']) {
      expect(moduleKeyForPath(path)).toBeNull();
    }
  });
});
