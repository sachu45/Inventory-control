import { describe, expect, it } from 'vitest';
import type { MeConfig, MeSidebarLink } from '@/api/me-config';
import type { AuthUser } from '@/store/authStore';
import { menuIcons } from '@/config/iconMap';
import { SIDEBAR_SECTIONS, applySidebarPreferences, flattenLinks, sectionsFromMeConfig } from './sidebar-navigation';
import { simpleNavigation, visibleTools } from './simple-navigation';

const link = (key: string, label: string, path: string, icon: string, locked = false): MeSidebarLink => ({ key, label, path, icon, locked });

/** What GET /me/config returns for an org admin with no published config (registry defaults). */
function defaultConfig(): MeConfig {
  return {
    version: 0,
    modules: {},
    preferences: {},
    sidebar: [
      { id: 'overview', title: 'Overview', children: [link('dashboard', 'Dashboard', '/dashboard', 'dashboard')] },
      { id: 'master-data', title: 'Catalog & contacts', children: [
        link('storage-locations', 'Storage Locations', '/storage-locations', 'storageLocations'),
        link('products', 'Products', '/products', 'products'),
        link('suppliers', 'Suppliers', '/suppliers', 'suppliers'),
        link('customers', 'Customers', '/customers', 'customers'),
      ] },
      { id: 'procurement', title: 'Purchasing', children: [
        link('rfqs', 'Quote Requests', '/rfqs', 'rfqs'),
        link('contracts', 'Contracts', '/contracts', 'contracts'),
        link('purchase-orders', 'Purchase Orders', '/purchase-orders', 'purchaseOrders'),
        link('goods-receipts', 'Receive Stock', '/goods-receipts', 'goodsReceipt'),
        link('returns', 'Return Stock', '/returns', 'goodsReturns'),
        link('supplier-portal', 'Supplier Portal', '/supplier-portal', 'supplierPortal'),
        link('supplier-bills', 'Supplier Bills', '/supplier-bills', 'supplierBills'),
        link('supplier-payments', 'Supplier Payments', '/supplier-payments', 'supplierPayments'),
      ] },
      { id: 'sales-finance', title: 'Sales & billing', children: [
        link('sales-quotations', 'Sales Quotations', '/quotations', 'salesQuotations'),
        link('sales', 'Sales Orders', '/sales', 'sales'),
        link('goods-issues', 'Send Stock', '/goods-issues', 'goodsIssue'),
        link('invoices', 'Invoices', '/invoices', 'invoices'),
        link('eway-bills', 'E-Way Bills', '/eway-bills', 'ewayBills'),
        link('payments', 'Payments', '/payments', 'payments'),
      ] },
      { id: 'operations', title: 'Inventory & tools', children: [
        link('stock-transfers', 'Stock Transfers', '/stock-transfers', 'stockTransfers'),
        link('warehouse', 'Warehouse', '/warehouse', 'warehouseOps'),
        link('reports', 'Reports', '/reports', 'reports'),
        link('approvals', 'Approvals', '/approvals', 'approvals'),
        link('barcode-print', 'Print Labels', '/barcode-print', 'printLabels'),
      ] },
    ],
  };
}

const without = (config: MeConfig, keys: string[]): MeConfig => ({
  ...config,
  sidebar: config.sidebar
    .map(section => ({ ...section, children: section.children.filter(child => !keys.includes(child.key)) }))
    .filter(section => section.children.length > 0),
});

const owner: AuthUser = { id: 'owner', email: 'o@example.test', name: 'Owner', role: 'OWNER', shopId: null, companyId: 'c1', permissions: [] };
const strip = (sections: ReturnType<typeof sectionsFromMeConfig>) =>
  sections.map(s => ({ id: s.id, title: s.title, links: flattenLinks(s.children).map(l => [l.label, l.path, l.icon, l.badge?.type ?? null]) }));

describe('sectionsFromMeConfig', () => {
  it('renders exactly the built-in sidebar for the default config', () => {
    expect(strip(sectionsFromMeConfig(defaultConfig()))).toEqual(strip(SIDEBAR_SECTIONS));
    expect(visibleTools({ ...owner, isPlatformAdmin: true }, defaultConfig()).map(t => t.path))
      .toEqual(visibleTools({ ...owner, isPlatformAdmin: true }).map(t => t.path));
    expect(simpleNavigation(owner, defaultConfig())).toEqual(simpleNavigation(owner));
  });

  it('drops modules the server left out, and their nav entries', () => {
    const config = without(defaultConfig(), ['reports', 'contracts', 'dashboard']);
    const paths = visibleTools(owner, config).map(t => t.path);
    expect(paths).not.toContain('/reports');
    expect(paths).not.toContain('/contracts');
    expect(sectionsFromMeConfig(config).map(s => s.id)).not.toContain('overview');
    const labels = simpleNavigation(owner, config).map(l => l.label);
    expect(labels).not.toContain('Reports');
    expect(labels).not.toContain('Home');
  });

  it('does no client gating of server links, but keeps Platform Admin behind its own gate', () => {
    const employee: AuthUser = { ...owner, role: 'EMPLOYEE', permissions: [] };
    expect(visibleTools(employee, defaultConfig()).map(t => t.path)).toContain('/purchase-orders');
    expect(visibleTools(employee, defaultConfig()).map(t => t.path)).not.toContain('/platform/subscriptions');
    expect(visibleTools({ ...employee, isPlatformAdmin: true }, defaultConfig()).map(t => t.path)).toContain('/platform/subscriptions');
    // Still shown, in its built-in section, when every module there is disabled.
    const bare = without(defaultConfig(), ['stock-transfers', 'warehouse', 'reports', 'approvals', 'barcode-print']);
    expect(sectionsFromMeConfig(bare).at(-1)).toMatchObject({ id: 'operations' });
    expect(visibleTools({ ...employee, isPlatformAdmin: true }, bare).map(t => t.path)).toContain('/platform/subscriptions');
  });

  it('uses server labels, keys and lock flags, and falls back to a known icon', () => {
    const config = defaultConfig();
    config.sidebar[2].children[1] = { ...config.sidebar[2].children[1], label: 'Agreements', locked: true };
    config.sidebar[2].children[2] = { ...config.sidebar[2].children[2], icon: 'not-an-icon' };
    const procurement = sectionsFromMeConfig(config).find(s => s.id === 'procurement')!;
    const [, contracts, po] = flattenLinks(procurement.children);
    expect(contracts).toMatchObject({ label: 'Agreements', moduleKey: 'contracts', locked: true });
    expect(po.icon).toBe(menuIcons.purchaseOrders);
  });

  it('ignores sections it does not know', () => {
    const config = defaultConfig();
    config.sidebar.push({ id: 'ghost', title: 'Ghost', children: [link('ghost', 'Ghost', '/ghost', 'dashboard')] });
    expect(visibleTools(owner, config).map(t => t.path)).not.toContain('/ghost');
  });

  it('applies the user sidebar preferences within each section', () => {
    const config = defaultConfig();
    config.preferences = { sidebar: { pinned: ['customers'], order: ['suppliers', 'products'] } };
    const master = sectionsFromMeConfig(config).find(s => s.id === 'master-data')!;
    expect(flattenLinks(master.children).map(l => l.path)).toEqual(['/customers', '/suppliers', '/products', '/storage-locations']);
  });
});

describe('applySidebarPreferences', () => {
  const items = ['a', 'b', 'c', 'd'].map(key => ({ key }));
  it('keeps server order without preferences', () => {
    expect(applySidebarPreferences(items, undefined)).toBe(items);
  });
  it('puts pinned first, then ordered, then the rest in server order', () => {
    expect(applySidebarPreferences(items, { pinned: ['d'], order: ['c'] }).map(i => i.key)).toEqual(['d', 'c', 'a', 'b']);
  });
});
