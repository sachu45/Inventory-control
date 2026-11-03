import { NavLink, useLocation } from 'react-router-dom';
import { visibleTools, TOOL_GROUPS, TOOL_COPY } from '@/lib/simple-navigation';
import { useAuthStore } from '@/store/authStore';

export function ModuleNavigation() {
  const location = useLocation();
  const user = useAuthStore(s => s.user);
  const selected = new URLSearchParams(location.search).get('section');
  const route = '/' + location.pathname.split('/')[1];
  const id = route === '/tools' ? selected : ['/purchase-orders', '/rfqs', '/contracts', '/goods-receipts', '/returns', '/supplier-bills', '/supplier-payments', '/supplier-portal'].includes(route) ? 'buying' : ['/sales', '/quotations', '/invoices', '/payments', '/goods-issues', '/eway-bills'].includes(route) ? 'selling' : ['/customers', '/suppliers'].includes(route) ? 'people' : ['/products', '/warehouse', '/storage-locations', '/stock-transfers', '/barcode-print'].includes(route) ? 'stock' : null;
  const group = TOOL_GROUPS.find(item => item.id === id);
  if (!group) return null;
  const allowed = new Set(visibleTools(user).map(tool => tool.path));
  const paths = group.paths.filter(path => allowed.has(path));
  return <nav className="erp-module-nav" aria-label={`${group.label} navigation`}>
    <NavLink to={`/tools?section=${group.id}`} className={location.pathname === '/tools' ? 'module-active' : ''}>{group.label}</NavLink>
    <span className="erp-module-divider" />
    {paths.map(path => <NavLink key={path} to={path} className={({ isActive }) => isActive ? 'module-active' : ''}>{TOOL_COPY[path]?.[0] ?? path}</NavLink>)}
  </nav>;
}
