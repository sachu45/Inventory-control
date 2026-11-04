import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronsLeft, ChevronUp, Settings, HelpCircle } from '@/components/ui/icons';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { resetClientSessionState } from '@/lib/reset-session-state';
import { cn } from '@/lib/cn';
import { useAuthStore } from '@/store/authStore';
import { ProfileMenuLinks } from '@/components/ProfileMenuLinks';
import { BrandLogo } from '@/components/BrandLogo';
import { simpleNavigation } from '@/lib/simple-navigation';
import { preloadRoute } from '@/lib/route-preload';
import { trackNavOpen } from '@/lib/nav-analytics';
import { useMeConfig } from '@/hooks/use-me-config';

type SidebarProps = {
  collapsed: boolean; onCollapsedChange: (collapsed: boolean) => void;
  isMobile?: boolean; mobileOpen?: boolean; onMobileOpenChange?: (open: boolean) => void;
};

export function Sidebar({ collapsed, onCollapsedChange, isMobile = false, mobileOpen = false, onMobileOpenChange }: SidebarProps) {
  const nav = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const user = useAuthStore(s => s.user);
  const clear = useAuthStore(s => s.clear);
  const [profileOpen, setProfileOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const expanded = !collapsed || isMobile;
  const meConfig = useMeConfig();
  const links = simpleNavigation(user, meConfig);
  const section = new URLSearchParams(location.search).get('section');
  const initials = (user?.name ?? 'User').split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase();

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) setProfileOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setProfileOpen(false); onMobileOpenChange?.(false); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [onMobileOpenChange]);

  function open(path: string) {
    trackNavOpen(path);
    setProfileOpen(false);
    nav(path);
    onMobileOpenChange?.(false);
  }

  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    try { await api.post('/auth/logout'); } catch { /* session still clears locally */ }
    delete api.defaults.headers.common.Authorization;
    resetClientSessionState(queryClient);
    clear();
    open('/login');
  }

  return <>
    {isMobile && mobileOpen && <button type="button" className="fixed inset-0 z-40 bg-slate-900/30 md:hidden" aria-label="Close navigation" onClick={() => onMobileOpenChange?.(false)} />}
    <aside inert={isMobile && !mobileOpen ? true : undefined} aria-hidden={isMobile && !mobileOpen} className={cn('sidebar simple-sidebar no-print fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border bg-card transition-[width,transform] duration-200',
      isMobile ? ['w-[280px] max-w-[85vw] md:hidden', mobileOpen ? 'translate-x-0' : '-translate-x-full'] : collapsed ? 'w-[72px]' : 'w-[240px]')}>
      <div className="simple-sidebar-brand">
        <BrandLogo size={30} iconOnly />
        {expanded && <span className="text-sm font-semibold">SoftdigitIMS</span>}
        {expanded && <button type="button" className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => isMobile ? onMobileOpenChange?.(false) : onCollapsedChange(true)} aria-label={isMobile ? 'Close navigation' : 'Collapse sidebar'}><ChevronsLeft size={16} /></button>}
      </div>
      <nav className="simple-main-nav" aria-label="Main navigation">
        {links.map(link => {
          const active = location.pathname === '/tools'
            ? (link.path.includes('?') ? new URLSearchParams(link.path.split('?')[1]).get('section') === section : link.path === '/tools' && !section)
            : link.matches.some(path => location.pathname === path || location.pathname.startsWith(path + '/'));
          return <button key={link.path} type="button" onClick={() => open(link.path)} onMouseEnter={() => preloadRoute(link.path.split('?')[0])}
            className={cn('simple-nav-link', active && 'active', !expanded && 'icon-only')}
            aria-label={expanded ? undefined : link.label} aria-current={active ? 'page' : undefined} title={expanded ? undefined : link.label}>
            <link.icon size={20} />
            {expanded && <span><strong>{link.label}</strong></span>}
          </button>;
        })}
      </nav>
      <div className="simple-sidebar-footer">
        <button type="button" className={cn('simple-footer-link', location.pathname === '/help' && 'active')} onClick={() => open('/help')} title="Help"><HelpCircle size={18} />{expanded && <span>Help</span>}</button>
        <button type="button" className={cn('simple-footer-link', location.pathname === '/settings' && 'active')} onClick={() => open('/settings')} title="Settings"><Settings size={18} />{expanded && <span>Settings</span>}</button>
      </div>
      <div className="simple-sidebar-account relative" ref={profileRef}>
        <button type="button" className="simple-account-button" aria-label="Open account menu" aria-expanded={profileOpen} disabled={signingOut} onClick={() => setProfileOpen(open => !open)}>
          {user?.avatarUrl ? <img className="h-8 w-8 rounded-full object-cover" src={user.avatarUrl} alt="" /> : <span className="simple-initials">{initials}</span>}
          {expanded && <><span className="min-w-0 flex-1 truncate text-left text-sm">{signingOut ? 'Signing out…' : user?.name ?? 'My account'}</span><ChevronUp size={15} /></>}
        </button>
        {profileOpen && <div className="absolute bottom-full left-2 z-50 mb-2 w-64 max-w-[85vw] rounded-xl border border-border bg-popover py-1 shadow-lg"><ProfileMenuLinks variant="sidebar" onNavigate={open} onLogout={logout} /></div>}
      </div>
    </aside>
  </>;
}
