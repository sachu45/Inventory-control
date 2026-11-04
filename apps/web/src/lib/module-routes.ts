/**
 * First path segment of each tenant module's pages -> its module registry key
 * (apps/api/src/common/config/module-registry.ts). Paths not listed are not
 * module pages (profile, help, tools, platform admin…) and are never gated.
 */
const MODULE_BY_SEGMENT: Record<string, string> = {
  dashboard: 'dashboard',
  companies: 'companies',
  plants: 'plants',
  'storage-locations': 'storage-locations',
  products: 'products',
  suppliers: 'suppliers',
  customers: 'customers',
  rfqs: 'rfqs',
  contracts: 'contracts',
  'purchase-orders': 'purchase-orders',
  'goods-receipts': 'goods-receipts',
  returns: 'returns',
  'supplier-portal': 'supplier-portal',
  'supplier-bills': 'supplier-bills',
  'supplier-payments': 'supplier-payments',
  quotations: 'sales-quotations',
  sales: 'sales',
  'goods-issues': 'goods-issues',
  invoices: 'invoices',
  'eway-bills': 'eway-bills',
  payments: 'payments',
  'stock-transfers': 'stock-transfers',
  warehouse: 'warehouse',
  reports: 'reports',
  notifications: 'notifications',
  approvals: 'approvals',
  'barcode-print': 'barcode-print',
  settings: 'settings',
  upgrade: 'upgrade',
};

export function moduleKeyForPath(pathname: string): string | null {
  const segment = pathname.split('/').find(Boolean);
  return segment ? (MODULE_BY_SEGMENT[segment] ?? null) : null;
}
