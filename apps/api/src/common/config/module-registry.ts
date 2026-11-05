import { z } from 'zod';
import type { PlanFeature } from '../plans/plan-config';

export const SIDEBAR_SECTIONS = [
  { id: 'overview', title: 'Overview' },
  { id: 'master-data', title: 'Catalog & contacts' },
  { id: 'procurement', title: 'Purchasing' },
  { id: 'sales-finance', title: 'Sales & billing' },
  { id: 'operations', title: 'Inventory & tools' },
] as const;

export type SidebarSectionId = (typeof SIDEBAR_SECTIONS)[number]['id'];

// Order within a section is the sidebar order.
export const MODULE_KEYS = [
  'dashboard',
  'companies',
  'plants',
  'storage-locations',
  'products',
  'suppliers',
  'customers',
  'rfqs',
  'contracts',
  'purchase-orders',
  'goods-receipts',
  'returns',
  'supplier-portal',
  'supplier-bills',
  'supplier-payments',
  'sales-quotations',
  'sales',
  'goods-issues',
  'invoices',
  'eway-bills',
  'payments',
  'stock-transfers',
  'warehouse',
  'reports',
  'notifications',
  'approvals',
  'barcode-print',
  'settings',
  'upgrade',
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export interface ModuleDefinition {
  key: ModuleKey;
  label: string;
  description: string;
  sidebarSection: SidebarSectionId;
  sidebarPath: string;
  /** Key in the web app's `menuIcons` map. */
  sidebarIcon: string;
  /** False for modules reached from the header or settings rather than the sidebar. */
  inSidebar: boolean;
  requireOrgAdmin: boolean;
  defaultEnabled: boolean;
  /** Core modules a tenant config may never disable. */
  alwaysEnabled: boolean;
  planGate: PlanFeature | null;
  requiredPermission: string | null;
  dependsOn: ModuleKey[];
  configSchema: z.ZodType<ModuleSettings>;
  defaults: ModuleSettings;
  shopOverridable: (keyof ModuleSettings)[];
  customizableFields: string[];
  lockedMandatoryFields: string[];
  supportsCustomFields: boolean;
  supportsWorkflows: boolean;
}

export type ModuleSettings = {
  mandatoryFields: string[];
  hiddenFields: string[];
  label?: string;
};

/**
 * Settings every module shares. Field lists are limited to `customizableFields`,
 * so a locked mandatory field can never be named in `hiddenFields`.
 */
export function moduleSettingsSchema(
  customizableFields: readonly string[],
  lockedMandatoryFields: readonly string[] = [],
): z.ZodType<ModuleSettings> {
  const field = customizableFields.length
    ? z.enum(customizableFields as [string, ...string[]])
    : z.never();
  return z
    .strictObject({
      mandatoryFields: z.array(field),
      hiddenFields: z.array(field),
      label: z.string().trim().min(1).max(40).optional(),
    })
    .superRefine((settings, ctx) => {
      const mandatory = new Set(settings.mandatoryFields);
      const locked = new Set(lockedMandatoryFields);
      for (const hidden of settings.hiddenFields) {
        if (locked.has(hidden) || mandatory.has(hidden)) {
          ctx.addIssue({
            code: 'custom',
            path: ['hiddenFields'],
            message: `"${hidden}" is mandatory and cannot be hidden`,
          });
        }
      }
    });
}

const DEFAULT_SETTINGS: ModuleSettings = { mandatoryFields: [], hiddenFields: [] };

type ModuleInput = Pick<
  ModuleDefinition,
  'label' | 'description' | 'sidebarSection' | 'sidebarPath' | 'sidebarIcon'
> &
  Partial<Omit<ModuleDefinition, 'key' | 'configSchema' | 'defaults'>>;

function defineModule(key: ModuleKey, input: ModuleInput): ModuleDefinition {
  const customizableFields = input.customizableFields ?? [];
  const lockedMandatoryFields = input.lockedMandatoryFields ?? [];
  return {
    key,
    inSidebar: true,
    requireOrgAdmin: false,
    defaultEnabled: true,
    alwaysEnabled: false,
    planGate: null,
    requiredPermission: null,
    dependsOn: [],
    shopOverridable: [],
    supportsCustomFields: false,
    supportsWorkflows: false,
    ...input,
    customizableFields,
    lockedMandatoryFields,
    configSchema: moduleSettingsSchema(customizableFields, lockedMandatoryFields),
    defaults: DEFAULT_SETTINGS,
  };
}

// Field lists are filled in per module as its write APIs start enforcing them;
// an empty list means the module has no customizable standard fields yet.
export const MODULE_REGISTRY: Readonly<Record<ModuleKey, ModuleDefinition>> = {
  dashboard: defineModule('dashboard', {
    label: 'Dashboard',
    description: 'Company overview and key metrics',
    sidebarSection: 'overview',
    sidebarPath: '/dashboard',
    sidebarIcon: 'dashboard',
    requireOrgAdmin: true,
  }),
  companies: defineModule('companies', {
    label: 'Companies',
    description: 'Company profile and legal details',
    sidebarSection: 'master-data',
    sidebarPath: '/companies',
    sidebarIcon: 'companies',
    inSidebar: false,
    // Most screens read the company profile and shop list; disabling them would break the app shell.
    alwaysEnabled: true,
    requiredPermission: 'company:read',
  }),
  plants: defineModule('plants', {
    label: 'Plants',
    description: 'Stores, plants and branches',
    sidebarSection: 'master-data',
    sidebarPath: '/plants',
    sidebarIcon: 'plants',
    inSidebar: false,
    // Most screens read the company profile and shop list; disabling them would break the app shell.
    alwaysEnabled: true,
    requiredPermission: 'shop:read',
  }),
  'storage-locations': defineModule('storage-locations', {
    label: 'Storage Locations',
    description: 'Bins, racks and storage areas within a plant',
    sidebarSection: 'master-data',
    sidebarPath: '/storage-locations',
    sidebarIcon: 'storageLocations',
    requiredPermission: 'storage_location:read',
  }),
  products: defineModule('products', {
    label: 'Products',
    description: 'Product catalogue, pricing and tax details',
    sidebarSection: 'master-data',
    sidebarPath: '/products',
    sidebarIcon: 'products',
    requiredPermission: 'product:read',
    customizableFields: ['hsnCode', 'materialGroup', 'drawingReference', 'brand'],
    lockedMandatoryFields: ['productCode', 'description', 'uom', 'category'],
    supportsCustomFields: true,
  }),
  suppliers: defineModule('suppliers', {
    label: 'Suppliers',
    description: 'Supplier master and vendor profiles',
    sidebarSection: 'master-data',
    sidebarPath: '/suppliers',
    sidebarIcon: 'suppliers',
    requiredPermission: 'supplier:read',
    supportsCustomFields: true,
  }),
  customers: defineModule('customers', {
    label: 'Customers',
    description: 'Customer master and contacts',
    sidebarSection: 'master-data',
    sidebarPath: '/customers',
    sidebarIcon: 'customers',
    requiredPermission: 'shop:read',
    supportsCustomFields: true,
  }),
  rfqs: defineModule('rfqs', {
    label: 'Quote Requests',
    description: 'Requests for quotation sent to suppliers',
    sidebarSection: 'procurement',
    sidebarPath: '/rfqs',
    sidebarIcon: 'rfqs',
    planGate: 'rfqs',
    requiredPermission: 'rfq:read',
    dependsOn: ['products', 'suppliers'],
    supportsWorkflows: true,
  }),
  contracts: defineModule('contracts', {
    label: 'Contracts',
    description: 'Supplier contracts and agreed rates',
    sidebarSection: 'procurement',
    sidebarPath: '/contracts',
    sidebarIcon: 'contracts',
    planGate: 'contracts',
    requiredPermission: 'contract:read',
    dependsOn: ['suppliers'],
  }),
  'purchase-orders': defineModule('purchase-orders', {
    label: 'Purchase Orders',
    description: 'Procurement purchase orders',
    sidebarSection: 'procurement',
    sidebarPath: '/purchase-orders',
    sidebarIcon: 'purchaseOrders',
    planGate: 'purchase_orders',
    requiredPermission: 'purchase_order:read',
    dependsOn: ['products', 'suppliers'],
    customizableFields: ['remarks', 'contractId', 'rfqId', 'lineDescription', 'lineCategory'],
    lockedMandatoryFields: ['supplier', 'shopId', 'poDate', 'items'],
    supportsCustomFields: true,
    supportsWorkflows: true,
  }),
  'goods-receipts': defineModule('goods-receipts', {
    label: 'Receive Stock',
    description: 'Goods receipts into stock',
    sidebarSection: 'procurement',
    sidebarPath: '/goods-receipts',
    sidebarIcon: 'goodsReceipt',
    dependsOn: ['products'],
    supportsCustomFields: true,
    supportsWorkflows: true,
  }),
  returns: defineModule('returns', {
    label: 'Return Stock',
    description: 'Customer and supplier returns',
    sidebarSection: 'procurement',
    sidebarPath: '/returns',
    sidebarIcon: 'goodsReturns',
    requiredPermission: 'shop:read',
    dependsOn: ['products'],
  }),
  'supplier-portal': defineModule('supplier-portal', {
    label: 'Supplier Portal',
    description: 'Supplier self-service quotes and acknowledgements',
    sidebarSection: 'procurement',
    sidebarPath: '/supplier-portal',
    sidebarIcon: 'supplierPortal',
    planGate: 'supplier_portal',
    requiredPermission: 'supplier:read',
    dependsOn: ['suppliers'],
  }),
  'supplier-bills': defineModule('supplier-bills', {
    label: 'Supplier Bills',
    description: 'Bills received from suppliers',
    sidebarSection: 'procurement',
    sidebarPath: '/supplier-bills',
    sidebarIcon: 'supplierBills',
    requiredPermission: 'shop:read',
    dependsOn: ['suppliers'],
  }),
  'supplier-payments': defineModule('supplier-payments', {
    label: 'Supplier Payments',
    description: 'Payments made against supplier bills',
    sidebarSection: 'procurement',
    sidebarPath: '/supplier-payments',
    sidebarIcon: 'supplierPayments',
    requiredPermission: 'shop:read',
    dependsOn: ['supplier-bills'],
  }),
  'sales-quotations': defineModule('sales-quotations', {
    label: 'Sales Quotations',
    description: 'Quotations sent to customers',
    sidebarSection: 'sales-finance',
    sidebarPath: '/quotations',
    sidebarIcon: 'salesQuotations',
    planGate: 'sales_quotations',
    requiredPermission: 'shop:read',
    dependsOn: ['products', 'customers'],
    supportsWorkflows: true,
  }),
  sales: defineModule('sales', {
    label: 'Sales Orders',
    description: 'Customer sales orders',
    sidebarSection: 'sales-finance',
    sidebarPath: '/sales',
    sidebarIcon: 'sales',
    planGate: 'sales_orders',
    requiredPermission: 'shop:read',
    dependsOn: ['products', 'customers'],
    customizableFields: ['expectedDate', 'remarks'],
    lockedMandatoryFields: ['customerId', 'items'],
    supportsCustomFields: true,
  }),
  'goods-issues': defineModule('goods-issues', {
    label: 'Send Stock',
    description: 'Goods issues out of stock',
    sidebarSection: 'sales-finance',
    sidebarPath: '/goods-issues',
    sidebarIcon: 'goodsIssue',
    requiredPermission: 'goods_issue:read',
    dependsOn: ['products'],
    supportsCustomFields: true,
  }),
  invoices: defineModule('invoices', {
    label: 'Invoices',
    description: 'GST invoices to customers',
    sidebarSection: 'sales-finance',
    sidebarPath: '/invoices',
    sidebarIcon: 'invoices',
    planGate: 'invoices',
    requiredPermission: 'shop:read',
    dependsOn: ['customers'],
    customizableFields: ['dueDate', 'remarks'],
    lockedMandatoryFields: ['customerId', 'totalValue'],
    supportsCustomFields: true,
    supportsWorkflows: true,
  }),
  'eway-bills': defineModule('eway-bills', {
    label: 'E-Way Bills',
    description: 'E-way bills for invoiced shipments',
    sidebarSection: 'sales-finance',
    sidebarPath: '/eway-bills',
    sidebarIcon: 'ewayBills',
    requiredPermission: 'shop:read',
    dependsOn: ['invoices'],
  }),
  payments: defineModule('payments', {
    label: 'Payments',
    description: 'Customer payments allocated to invoices',
    sidebarSection: 'sales-finance',
    sidebarPath: '/payments',
    sidebarIcon: 'payments',
    planGate: 'payments',
    requiredPermission: 'shop:read',
    dependsOn: ['invoices'],
  }),
  'stock-transfers': defineModule('stock-transfers', {
    label: 'Stock Transfers',
    description: 'Transfers between plants and storage locations',
    sidebarSection: 'operations',
    sidebarPath: '/stock-transfers',
    sidebarIcon: 'stockTransfers',
    requiredPermission: 'stock_transfer:read',
    dependsOn: ['storage-locations'],
    supportsWorkflows: true,
  }),
  warehouse: defineModule('warehouse', {
    label: 'Warehouse',
    description: 'Warehouse operations and stock by location',
    sidebarSection: 'operations',
    sidebarPath: '/warehouse',
    sidebarIcon: 'warehouseOps',
    requiredPermission: 'report:view',
    dependsOn: ['storage-locations'],
  }),
  reports: defineModule('reports', {
    label: 'Reports',
    description: 'Inventory, sales and finance reports',
    sidebarSection: 'operations',
    sidebarPath: '/reports',
    sidebarIcon: 'reports',
    planGate: 'reports',
    requiredPermission: 'report:view',
  }),
  notifications: defineModule('notifications', {
    label: 'Notifications',
    description: 'In-app alerts and notification history',
    sidebarSection: 'operations',
    sidebarPath: '/notifications',
    sidebarIcon: 'notifications',
    inSidebar: false,
    requiredPermission: 'report:view',
  }),
  approvals: defineModule('approvals', {
    label: 'Approvals',
    description: 'Pending approval requests',
    sidebarSection: 'operations',
    sidebarPath: '/approvals',
    sidebarIcon: 'approvals',
    requiredPermission: 'shop:read',
  }),
  'barcode-print': defineModule('barcode-print', {
    label: 'Print Labels',
    description: 'Barcode and label printing',
    sidebarSection: 'operations',
    sidebarPath: '/barcode-print',
    sidebarIcon: 'printLabels',
    dependsOn: ['products'],
  }),
  settings: defineModule('settings', {
    label: 'Settings',
    description: 'Company settings and preferences',
    sidebarSection: 'operations',
    sidebarPath: '/settings',
    sidebarIcon: 'settings',
    inSidebar: false,
    alwaysEnabled: true,
  }),
  upgrade: defineModule('upgrade', {
    label: 'Upgrade',
    description: 'Plans and subscription billing',
    sidebarSection: 'operations',
    sidebarPath: '/upgrade',
    sidebarIcon: 'upgrade',
    inSidebar: false,
    alwaysEnabled: true,
    requiredPermission: 'billing:manage',
  }),
};

export function isModuleKey(value: string): value is ModuleKey {
  return Object.prototype.hasOwnProperty.call(MODULE_REGISTRY, value);
}

export type SidebarEntry = {
  label: string;
  path: string;
  icon: string;
  permission: string | null;
  requireOrgAdmin: boolean;
};

/** Sidebar sections derived from the given modules, in registry order; empty sections are dropped. */
export function deriveSidebar(
  modules: readonly ModuleDefinition[] = MODULE_KEYS.map((key) => MODULE_REGISTRY[key]),
): { id: SidebarSectionId; title: string; children: SidebarEntry[] }[] {
  return SIDEBAR_SECTIONS.map(({ id, title }) => ({
    id,
    title,
    children: modules
      .filter((mod) => mod.inSidebar && mod.sidebarSection === id)
      .map((mod) => ({
        label: mod.label,
        path: mod.sidebarPath,
        icon: mod.sidebarIcon,
        permission: mod.requiredPermission,
        requireOrgAdmin: mod.requireOrgAdmin,
      })),
  })).filter((section) => section.children.length > 0);
}
