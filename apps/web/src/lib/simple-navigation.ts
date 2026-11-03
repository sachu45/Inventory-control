import type { AuthUser } from '@/store/authStore';
import { isOrgAdminUser, isPlatformAdminUser } from '@/lib/roles';
import { SIDEBAR_SECTIONS, flattenLinks, type SidebarLink } from '@/lib/sidebar-navigation';
import { menuIcons } from '@/config/iconMap';
import { MoreHorizontal } from '@/components/ui/icons';

export const TOOL_COPY: Record<string, [string, string]> = {
  '/dashboard': ['Home', 'A quick look at your business'],
  '/products': ['Products', 'Add and manage the items you sell'],
  '/warehouse': ['Stock', 'See what is available and where it is kept'],
  '/goods-receipts': ['Receive stock', 'Record items arriving from a supplier'],
  '/goods-issues': ['Send stock', 'Record items leaving your storage'],
  '/storage-locations': ['Storage areas', 'Choose where items are kept inside a location'],
  '/stock-transfers': ['Move stock', 'Move items between your locations'],
  '/barcode-print': ['Print labels', 'Create barcode labels for your items'],
  '/suppliers': ['Suppliers', 'People and businesses you buy from'],
  '/customers': ['Customers', 'People and businesses you sell to'],
  '/purchase-orders': ['Purchase orders', 'Order items from a supplier'],
  '/rfqs': ['Ask for prices', 'Request a price quote from suppliers'],
  '/contracts': ['Supplier agreements', 'Manage the terms agreed with suppliers'],
  '/returns': ['Return items', 'Send items back to a supplier'],
  '/supplier-portal': ['Supplier portal', 'Share purchase information with suppliers'],
  '/supplier-bills': ['Supplier bills', 'Track the money you owe suppliers'],
  '/supplier-payments': ['Pay suppliers', 'Record payments made to suppliers'],
  '/quotations': ['Price quotes', 'Prepare a price offer for a customer'],
  '/sales': ['Customer orders', 'Track what your customers have ordered'],
  '/invoices': ['Customer bills', 'Create and manage customer invoices'],
  '/payments': ['Customer payments', 'Record money received from customers'],
  '/eway-bills': ['Transport documents', 'Manage E-Way Bills for moving goods'],
  '/reports': ['Reports', 'Understand your stock, purchases and sales'],
  '/approvals': ['Approvals', 'Review requests that need your permission'],
  '/platform/subscriptions': ['Platform admin', 'Manage platform subscriptions and health'],
};

export function visibleTools(user: AuthUser | null | undefined): SidebarLink[] {
  const admin = isOrgAdminUser(user);
  return SIDEBAR_SECTIONS.flatMap(s => flattenLinks(s.children)).filter(link =>
    (!link.requireOrgAdmin || admin) &&
    (!link.requirePlatformAdmin || isPlatformAdminUser(user)) &&
    (!link.permission || admin || user?.permissions?.includes(link.permission)),
  );
}

export const TOOL_GROUPS = [
  { id: 'stock', label: 'Stock & products', description: 'Keep track of your items.', paths: ['/products', '/warehouse', '/goods-receipts', '/goods-issues', '/stock-transfers', '/storage-locations', '/barcode-print'] },
  { id: 'buying', label: 'Buying', description: 'Order items, receive deliveries and pay suppliers.', paths: ['/purchase-orders', '/goods-receipts', '/returns', '/rfqs', '/contracts', '/supplier-bills', '/supplier-payments', '/supplier-portal'] },
  { id: 'selling', label: 'Selling', description: 'Manage customer orders, bills and payments.', paths: ['/sales', '/quotations', '/invoices', '/payments', '/goods-issues', '/eway-bills'] },
  { id: 'people', label: 'People', description: 'The people you buy from and sell to.', paths: ['/customers', '/suppliers'] },
  { id: 'review', label: 'Reports & other tools', description: 'Check progress and review requests.', paths: ['/reports', '/approvals', '/platform/subscriptions'] },
];

export function simpleNavigation(user: AuthUser | null | undefined) {
  const tools = visibleTools(user);
  const can = (path: string) => tools.some(t => t.path === path);
  const groupPaths = (id: string) => TOOL_GROUPS.find(g => g.id === id)!.paths;
  return [
    { label: 'Home', hint: 'Start here', path: '/dashboard', icon: menuIcons.dashboard, matches: ['/dashboard'], visible: can('/dashboard') },
    { label: 'Products', hint: 'Your list of items', path: '/products', icon: menuIcons.products, matches: ['/products'], visible: can('/products') },
    { label: 'Stock', hint: 'What you have', path: '/warehouse', icon: menuIcons.warehouseOps, matches: ['/warehouse', '/storage-locations', '/stock-transfers', '/barcode-print'], visible: can('/warehouse') },
    { label: 'Buying', hint: 'Order and receive items', path: '/tools?section=buying', icon: menuIcons.purchaseOrders, matches: groupPaths('buying'), visible: groupPaths('buying').some(can) },
    { label: 'Selling', hint: 'Orders, bills and payments', path: '/tools?section=selling', icon: menuIcons.sales, matches: groupPaths('selling').filter(p => p !== '/goods-issues'), visible: groupPaths('selling').some(can) },
    { label: 'People', hint: 'Customers and suppliers', path: '/tools?section=people', icon: menuIcons.customers, matches: groupPaths('people'), visible: groupPaths('people').some(can) },
    { label: 'Reports', hint: 'See how things are going', path: '/reports', icon: menuIcons.reports, matches: ['/reports'], visible: can('/reports') },
    { label: 'More tools', hint: 'Find any other task', path: '/tools', icon: MoreHorizontal, matches: ['/approvals', '/platform/subscriptions', '/goods-issues'], visible: true },
  ].filter(item => item.visible);
}
