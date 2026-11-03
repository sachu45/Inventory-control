import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Bell, ChevronDown, Menu, Loader2 } from '@/components/ui/icons';
import { ProfileMenuLinks } from '@/components/ProfileMenuLinks';
import { AppShellControls } from '@/components/AppShellControls';
import { ApplicationLauncher } from '@/components/ApplicationLauncher';
import { ModuleNavigation } from '@/components/ModuleNavigation';
import { Breadcrumbs } from '@/components/navigation/Breadcrumbs';
import { useBreadcrumbs } from '@/hooks/use-breadcrumbs';
import { CommandSpotlight } from '@/components/CommandSpotlight';
import { useQueryClient } from '@tanstack/react-query';
import { resetClientSessionState } from '@/lib/reset-session-state';
import { Sidebar } from './Sidebar';
import { Toaster } from '@/components/ui/sonner';
import { useAuthStore } from '@/store/authStore';
import { api } from '@/api/client';
import { cn } from '@/lib/cn';
import {
  useNotificationFeed,
  useUnreadNotificationCount,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
} from '@/hooks/use-notification-feed';
import { notificationVisual, timeAgo } from '@/lib/notification-presentation';
import { AppFooter } from '@/components/AppFooter';
import { OrganisationIdBadge } from '@/components/OrganisationIdBadge';
import { TrialUpgradeBanner } from '@/components/TrialUpgradeBanner';
import { useSubscription } from '@/hooks/use-subscription';
import { resolvePageTitle } from '@/lib/page-titles';
import { PageTransition, RouteProgressBar } from '@/components/motion';

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)');
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}

type AppLayoutProps = {
  children: React.ReactNode;
  active?: string;
};

export function AppLayout({ children, active }: AppLayoutProps) {
  const location = useLocation();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const isMobile = useIsMobile();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    typeof window !== 'undefined' ? false : true,
  );
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [showLogoutSplash, setShowLogoutSplash] = useState(false);
  const [routeProgress, setRouteProgress] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const feedQuery = useNotificationFeed({ limit: 8 });
  const unreadCountQuery = useUnreadNotificationCount(Boolean(user));
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const notifications = feedQuery.data?.data ?? [];
  const unreadCount = unreadCountQuery.data ?? feedQuery.data?.unreadCount ?? 0;
  const { data: subscription } = useSubscription(Boolean(user));

  const pageTitle = active ?? resolvePageTitle(location.pathname);
  const breadcrumbs = useBreadcrumbs();

  useEffect(() => {
    function close(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
      if (notificationsRef.current && !notificationsRef.current.contains(e.target as Node)) {
        setNotificationsOpen(false);
      }
    }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  useEffect(() => {
    setProfileOpen(false);
    setNotificationsOpen(false);
    if (isMobile) {
      setMobileSidebarOpen(false);
    }
  }, [isMobile, location.pathname]);

  useEffect(() => {
    setRouteProgress(true);
    const timer = window.setTimeout(() => setRouteProgress(false), 450);
    return () => window.clearTimeout(timer);
  }, [location.pathname]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSpotlightOpen(true);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobileSidebarOpen(false);
      setSidebarCollapsed(false);
    }
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile || !mobileSidebarOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile, mobileSidebarOpen]);

  async function handleLogout() {
    if (showLogoutSplash) return;
    setShowLogoutSplash(true);
    try { await api.post('/auth/logout'); } catch { /* best-effort server logout */ }
    delete api.defaults.headers.common.Authorization;
    resetClientSessionState(queryClient);
    clear();
    nav('/login', { replace: true });
  }

  const avatarUrl = user?.avatarUrl ?? null;

  return (
    <div className="workspace-shell flex min-h-screen bg-transparent text-foreground dark:text-slate-100">
      <CommandSpotlight open={spotlightOpen} onOpenChange={setSpotlightOpen} />
      {showLogoutSplash && <div className="fixed inset-0 z-100 flex items-center justify-center bg-background" role="status"><div className="flex items-center gap-3 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Signing you out…</div></div>}
      <Sidebar
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        isMobile={isMobile}
        mobileOpen={mobileSidebarOpen}
        onMobileOpenChange={setMobileSidebarOpen}
      />

      <div
        className={cn(
          'flex min-h-screen min-w-0 flex-1 flex-col transition-[margin] duration-300 ease-in-out',
          !isMobile && (sidebarCollapsed ? 'md:ml-[72px]' : 'md:ml-[240px]'),
        )}
      >
        <header className="workspace-topbar sticky top-0 z-30 border-b border-border bg-card">
          <div className="flex h-16 items-center gap-2 px-4 sm:gap-3 sm:px-6">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  isMobile ? setMobileSidebarOpen(true) : setSidebarCollapsed((c) => !c)
                }
                className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground dark:text-muted-foreground dark:hover:bg-slate-800 dark:hover:text-slate-100"
                aria-label={
                  isMobile
                    ? 'Open navigation'
                    : sidebarCollapsed
                      ? 'Expand sidebar'
                      : 'Collapse sidebar'
                }
              >
                <Menu className="h-5 w-5" />
              </button>
              <ApplicationLauncher />
              <div className="erp-header-breadcrumb hidden min-w-0 md:block">{breadcrumbs.items.length ? <Breadcrumbs items={breadcrumbs.items} /> : <span className="text-sm font-medium">{pageTitle}</span>}</div>
            </div>

            <OrganisationIdBadge className="hidden shrink-0 xl:flex" />

            <div className="flex flex-1 items-center justify-end gap-2 sm:gap-3">
              <AppShellControls onOpenSpotlight={() => setSpotlightOpen(true)} />

              <button
                type="button"
                onClick={() => setNotificationsOpen((open) => !open)}
                className="relative rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground dark:text-muted-foreground dark:hover:bg-slate-800 dark:hover:text-slate-100"
                aria-label="Notifications"
              >
                <Bell className="h-5 w-5" />
                {unreadCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>
              {notificationsOpen && (
                <>
                  <button
                    type="button"
                    aria-label="Close notifications"
                    onClick={() => setNotificationsOpen(false)}
                    className="fixed inset-0 z-30 bg-slate-900/25 dark:bg-black/40"
                  />
                  <div
                    ref={notificationsRef}
                    className="absolute right-2 top-14 z-40 w-96 max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl border border-border bg-card shadow-2xl dark:border-slate-700 dark:bg-slate-900 sm:right-16 sm:max-w-[calc(100vw-2rem)]"
                  >
                    <div className="flex items-center justify-between border-b border-border px-4 py-3 dark:border-slate-700">
                      <p className="text-base font-semibold text-foreground dark:text-slate-100">Notifications</p>
                      {unreadCount > 0 && (
                        <button
                          type="button"
                          className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                          onClick={() => markAllRead.mutate()}
                          disabled={markAllRead.isPending}
                        >
                          Mark all read
                        </button>
                      )}
                    </div>
                    <div className="max-h-[420px] overflow-y-auto">
                      {feedQuery.isLoading ? (
                        <div className="px-4 py-10 text-center text-sm text-muted-foreground">Loading…</div>
                      ) : notifications.length === 0 ? (
                        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                          You&apos;re all caught up.
                        </div>
                      ) : (
                        notifications.map((n) => {
                          const { Icon, badgeClass } = notificationVisual(n.type, n.priority);
                          return (
                            <button
                              key={n.id}
                              type="button"
                              onClick={() => {
                                if (!n.isRead) markRead.mutate(n.id);
                                if (n.deepLink) {
                                  setNotificationsOpen(false);
                                  nav(n.deepLink);
                                }
                              }}
                              className={cn(
                                'flex w-full items-start gap-3 border-b border-border px-4 py-3.5 text-left last:border-b-0 hover:bg-muted dark:border-slate-800 dark:hover:bg-slate-800/80',
                                !n.isRead && 'bg-blue-50/60 dark:bg-slate-800/50',
                              )}
                            >
                              <span className={cn('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full', badgeClass)}>
                                <Icon className="h-[18px] w-[18px]" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm font-semibold text-foreground dark:text-slate-100">
                                  {n.title}
                                </span>
                                <span className="mt-0.5 block text-sm text-muted-foreground dark:text-muted-foreground">
                                  {n.message}
                                </span>
                                <span className="mt-1 block text-xs text-muted-foreground dark:text-muted-foreground">
                                  {timeAgo(n.createdAt)}
                                </span>
                              </span>
                              {!n.isRead && (
                                <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-blue-500" aria-hidden="true" />
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setNotificationsOpen(false);
                        nav('/notifications');
                      }}
                      className="block w-full border-t border-border px-4 py-3 text-center text-sm font-semibold text-primary hover:bg-muted dark:border-slate-700 dark:hover:bg-slate-800/80"
                    >
                      View All Notifications
                    </button>
                  </div>
                </>
              )}

              <div className="relative" ref={profileRef}>
                <button
                  type="button"
                  onClick={() => setProfileOpen((open) => !open)}
                  className="flex items-center gap-2 rounded-xl p-1.5 hover:bg-muted dark:hover:bg-slate-800"
                >
                  <div className="erp-avatar flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm text-primary">
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt={`${user?.name ?? 'User'} avatar`}
                        className="h-8 w-8 rounded-full object-cover"
                      />
                    ) : (
                      <span aria-label={'Account avatar'} role="img">{(user?.name ?? 'User').split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</span>
                    )}
                  </div>
                  <div className="hidden text-left md:block">
                    <div className="text-sm font-medium leading-tight text-foreground dark:text-slate-100">{user?.name}</div>
                    <div className="text-xs text-muted-foreground dark:text-muted-foreground">{user?.role}</div>
                  </div>
                  <ChevronDown className="hidden h-4 w-4 text-muted-foreground md:block" />
                </button>

                {profileOpen && (
                  <div className="absolute right-0 top-full mt-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-card shadow-2xl dark:border-slate-700 dark:bg-slate-900">
                    <div className="border-b border-border px-4 py-3 dark:border-slate-700">
                      <div className="text-sm font-medium text-foreground dark:text-slate-100">{user?.name}</div>
                      <div className="text-xs text-muted-foreground">{user?.email}</div>
                      {user?.shop && (
                        <div className="mt-0.5 text-xs text-primary">{user.shop.shopName}</div>
                      )}
                    </div>
                    <ProfileMenuLinks
                      variant="header"
                      onNavigate={(path) => {
                        setProfileOpen(false);
                        nav(path);
                      }}
                      onLogout={handleLogout}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          <ModuleNavigation />
        </header>

        <main className="flex min-w-0 flex-1 flex-col p-4 sm:p-6">
          <RouteProgressBar active={routeProgress} />
          <div className="mx-auto w-full max-w-[1400px] flex-1">
            <TrialUpgradeBanner subscription={subscription} />
            <PageTransition routeKey={location.pathname}>{children}</PageTransition>
          </div>
          <AppFooter />
        </main>
      </div>

      <Toaster />
    </div>
  );
}
