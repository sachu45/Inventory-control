import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { LayoutDashboard, Package, ShoppingCart, Users, BarChart3, Settings, GitBranch } from '@/components/ui/icons';
import { useAuthStore } from '@/store/authStore';
import { visibleTools, TOOL_GROUPS } from '@/lib/simple-navigation';
import { isOrgAdminUser } from '@/lib/roles';

export function ApplicationLauncher() {
  const [open, setOpen] = useState(false);
  const user = useAuthStore(s => s.user);
  const navigate = useNavigate();
  const allowed = new Set(visibleTools(user).map(tool => tool.path));
  const has = (id: string) => TOOL_GROUPS.find(group => group.id === id)?.paths.some(path => allowed.has(path));
  const apps = [
    { label: 'Overview', description: 'Business metrics and recent activity', path: '/dashboard', icon: LayoutDashboard, enabled: allowed.has('/dashboard') },
    { label: 'Inventory', description: 'Products, stock and storage areas', path: '/tools?section=stock', icon: Package, enabled: has('stock') },
    { label: 'Purchasing', description: 'Suppliers, orders and goods receipts', path: '/tools?section=buying', icon: ShoppingCart, enabled: has('buying') },
    { label: 'Sales', description: 'Customer orders, invoices and payments', path: '/tools?section=selling', icon: BarChart3, enabled: has('selling') },
    { label: 'Contacts', description: 'Customers and suppliers', path: '/tools?section=people', icon: Users, enabled: has('people') },
    { label: 'Reports', description: 'Analysis, registers and exports', path: '/reports', icon: BarChart3, enabled: allowed.has('/reports') },
    { label: 'Approvals', description: 'Decisions, due dates and comments', path: '/approvals', icon: GitBranch, enabled: allowed.has('/approvals') },
    { label: 'Automation', description: 'Workflow rules and delivery insights', path: '/workflow-engine', icon: GitBranch, enabled: isOrgAdminUser(user) },
    { label: 'Settings', description: 'Your organisation, locations and account', path: '/settings', icon: Settings, enabled: true },
  ].filter(app => app.enabled);
  return <>
    <button className="erp-launcher-trigger" type="button" aria-label="Open application launcher" onClick={() => setOpen(true)}><LayoutDashboard size={19} /></button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="erp-launcher-dialog sm:max-w-3xl">
      <div><DialogTitle>Your applications</DialogTitle><DialogDescription>Choose a workspace to continue.</DialogDescription></div>
      <div className="erp-launcher-list">{apps.map(app => <button key={app.path} type="button" onClick={() => { setOpen(false); navigate(app.path); }}>
        <span className="erp-app-icon"><app.icon size={23} /></span><span><strong>{app.label}</strong><small>{app.description}</small></span>
      </button>)}</div>
    </DialogContent></Dialog>
  </>;
}
