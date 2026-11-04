import type { LucideIcon } from '@/components/ui/icons';
import { menuIcons } from '@/config/iconMap';
import type { MeConfig, MeSidebarLink, MeUserPreferences } from '@/api/me-config';

// Typed section IDs — no bare string literals across the codebase
export const SidebarSectionId = {
  Overview: 'overview',
  MasterData: 'master-data',
  Procurement: 'procurement',
  SalesFinance: 'sales-finance',
  Operations: 'operations',
} as const;
export type SidebarSectionId = (typeof SidebarSectionId)[keyof typeof SidebarSectionId];

// Structured badge metadata — extensible (number | warning | dot later)
export type SidebarBadge = { type: 'approvals' };

type GateFlags = {
  permission?: string;
  requireOrgAdmin?: boolean;
  requirePlatformAdmin?: boolean;
};

// Node model is nesting-ready; only 'link' nodes populated this round
export type SidebarLink = GateFlags & {
  kind: 'link';
  label: string;
  path: string;
  icon: LucideIcon;
  badge?: SidebarBadge;
  /** Module registry key, when the link came from `/me/config`. */
  moduleKey?: string;
  /** Plan does not include the module (from `/me/config`). */
  locked?: boolean;
};
export type SidebarGroup = GateFlags & {
  kind: 'group';
  label: string;
  icon: LucideIcon;
  children: SidebarNode[];
};
export type SidebarNode = SidebarLink | SidebarGroup;

export type SidebarSection = {
  id: SidebarSectionId;
  title: string;
  children: SidebarNode[];
};

// Walk nodes recursively, returning only links (for flat mode, indicator, preload)
export function flattenLinks(nodes: SidebarNode[]): SidebarLink[] {
  const out: SidebarLink[] = [];
  for (const node of nodes) {
    if (node.kind === 'link') out.push(node);
    else out.push(...flattenLinks(node.children));
  }
  return out;
}

const L = (
  label: string,
  path: string,
  icon: LucideIcon,
  extra?: Partial<Omit<SidebarLink, 'kind' | 'label' | 'path' | 'icon'>>,
): SidebarLink => ({ kind: 'link', label, path, icon, ...extra });

export const SIDEBAR_SECTIONS: SidebarSection[] = [
  {
    id: SidebarSectionId.Overview,
    title: 'Overview',
    children: [
      L('Dashboard', '/dashboard', menuIcons.dashboard, { requireOrgAdmin: true }),
    ],
  },
  {
    id: SidebarSectionId.MasterData,
    title: 'Catalog & contacts',
    children: [
      L('Storage Locations', '/storage-locations', menuIcons.storageLocations, { permission: 'storage_location:read' }),
      L('Products', '/products', menuIcons.products, { permission: 'product:read' }),
      L('Suppliers', '/suppliers', menuIcons.suppliers, { permission: 'supplier:read' }),
      L('Customers', '/customers', menuIcons.customers, { permission: 'shop:read' }),
    ],
  },
  {
    id: SidebarSectionId.Procurement,
    title: 'Purchasing',
    children: [
      L('Quote Requests', '/rfqs', menuIcons.rfqs, { permission: 'rfq:read' }),
      L('Contracts', '/contracts', menuIcons.contracts, { permission: 'contract:read' }),
      L('Purchase Orders', '/purchase-orders', menuIcons.purchaseOrders, { permission: 'purchase_order:read' }),
      L('Receive Stock', '/goods-receipts', menuIcons.goodsReceipt),
      L('Return Stock', '/returns', menuIcons.goodsReturns, { permission: 'shop:read' }),
      L('Supplier Portal', '/supplier-portal', menuIcons.supplierPortal, { permission: 'supplier:read' }),
      L('Supplier Bills', '/supplier-bills', menuIcons.supplierBills, { permission: 'shop:read' }),
      L('Supplier Payments', '/supplier-payments', menuIcons.supplierPayments, { permission: 'shop:read' }),
    ],
  },
  {
    id: SidebarSectionId.SalesFinance,
    title: 'Sales & billing',
    children: [
      L('Sales Quotations', '/quotations', menuIcons.salesQuotations, { permission: 'shop:read' }),
      L('Sales Orders', '/sales', menuIcons.sales, { permission: 'shop:read' }),
      L('Send Stock', '/goods-issues', menuIcons.goodsIssue, { permission: 'goods_issue:read' }),
      L('Invoices', '/invoices', menuIcons.invoices, { permission: 'shop:read' }),
      L('E-Way Bills', '/eway-bills', menuIcons.ewayBills, { permission: 'shop:read' }),
      L('Payments', '/payments', menuIcons.payments, { permission: 'shop:read' }),
    ],
  },
  {
    id: SidebarSectionId.Operations,
    title: 'Inventory & tools',
    children: [
      L('Stock Transfers', '/stock-transfers', menuIcons.stockTransfers, { permission: 'stock_transfer:read' }),
      L('Warehouse', '/warehouse', menuIcons.warehouseOps, { permission: 'report:view' }),
      L('Reports', '/reports', menuIcons.reports, { permission: 'report:view' }),
      L('Approvals', '/approvals', menuIcons.approvals, { permission: 'shop:read', badge: { type: 'approvals' } }),
      L('Platform Admin', '/platform/subscriptions', menuIcons.platformAdmin, { requirePlatformAdmin: true }),
      L('Print Labels', '/barcode-print', menuIcons.printLabels),
    ],
  },
];

const SECTION_IDS = new Set<string>(Object.values(SidebarSectionId));

/** Pinned keys first (in pin order), then the user's `order`, then the server's order. */
export function applySidebarPreferences<T extends { key: string }>(links: T[], prefs?: MeUserPreferences): T[] {
  const pinned = prefs?.pinned ?? [];
  const order = prefs?.order ?? [];
  if (!pinned.length && !order.length) return links;
  const rank = (key: string) => {
    const pin = pinned.indexOf(key);
    if (pin >= 0) return pin;
    const pos = order.indexOf(key);
    return pinned.length + (pos >= 0 ? pos : order.length);
  };
  return links
    .map((link, index) => ({ link, index }))
    .sort((a, b) => rank(a.link.key) - rank(b.link.key) || a.index - b.index)
    .map(({ link }) => link);
}

/**
 * Sidebar sections from `/me/config`. The server has already applied plan,
 * permission and business config, so nothing is gated here except links that
 * are not tenant modules (Platform Admin), which keep their client gates.
 */
export function sectionsFromMeConfig(config: MeConfig): SidebarSection[] {
  const builtIn = SIDEBAR_SECTIONS.flatMap((section) => flattenLinks(section.children));
  const byPath = new Map(builtIn.map((link) => [link.path, link]));
  const toLink = (link: MeSidebarLink): SidebarLink => {
    const known = byPath.get(link.path);
    return {
      kind: 'link',
      label: link.label,
      path: link.path,
      icon: menuIcons[link.icon as keyof typeof menuIcons] ?? known?.icon ?? menuIcons.dashboard,
      ...(known?.badge ? { badge: known.badge } : {}),
      moduleKey: link.key,
      locked: link.locked,
    };
  };

  const sections: SidebarSection[] = config.sidebar
    .filter((section) => SECTION_IDS.has(section.id))
    .map((section) => ({
      id: section.id as SidebarSectionId,
      title: section.title,
      children: applySidebarPreferences(section.children, config.preferences?.sidebar).map(toLink),
    }));

  // Non-module links go where the built-in sidebar has them: after their nearest
  // preceding built-in sibling that is still shown.
  for (const section of SIDEBAR_SECTIONS) {
    const builtInLinks = flattenLinks(section.children);
    const extras = builtInLinks.filter((link) => link.requirePlatformAdmin);
    if (!extras.length) continue;
    let target = sections.find((s) => s.id === section.id);
    if (!target) {
      target = { id: section.id, title: section.title, children: [] };
      sections.splice(sectionIndex(section.id, sections), 0, target);
    }
    for (const extra of extras) {
      const before = builtInLinks.slice(0, builtInLinks.indexOf(extra)).map((link) => link.path);
      let at = 0;
      target.children.forEach((child, index) => {
        if (child.kind === 'link' && before.includes(child.path)) at = index + 1;
      });
      target.children.splice(at, 0, extra);
    }
  }
  return sections;
}

/** Where a built-in section belongs among `sections`, keeping built-in section order. */
function sectionIndex(id: SidebarSectionId, sections: SidebarSection[]): number {
  const order = SIDEBAR_SECTIONS.map((section) => section.id);
  const index = sections.findIndex((section) => order.indexOf(section.id) > order.indexOf(id));
  return index < 0 ? sections.length : index;
}
