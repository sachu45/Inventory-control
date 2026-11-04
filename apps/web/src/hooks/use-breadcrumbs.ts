import { useMemo } from 'react';
import { matchPath, useLocation } from 'react-router-dom';
import { useAuthStore, type AuthUser } from '@/store/authStore';
import { isOrgAdminUser } from '@/lib/roles';
import { useRfq } from '@/hooks/use-rfqs';
import { useSalesOrder } from '@/hooks/use-sales-orders';
import { breadcrumbRoutes, type BreadcrumbLabelMap } from '@/lib/breadcrumbs';
import { useCustomModuleLabel } from '@/hooks/use-module-config';

type BreadcrumbResult = {
  items: { label: string; href?: string }[];
  subtitle?: string;
};

function resolveHomeHref(user: AuthUser | null): string {
  if (isOrgAdminUser(user)) return '/dashboard';
  return '/products';
}

export function useBreadcrumbs(): BreadcrumbResult {
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const homeHref = resolveHomeHref(user);
  const customLabel = useCustomModuleLabel();

  const rfqDetailMatch =
    matchPath({ path: '/rfqs/:id/compare', end: true }, location.pathname) ??
    matchPath({ path: '/rfqs/:id', end: true }, location.pathname);
  const rfqId = rfqDetailMatch?.params?.id;
  const resolvedRfqId = rfqId && rfqId !== 'new' ? rfqId : undefined;
  const rfqQuery = useRfq(resolvedRfqId);

  const salesMatch = matchPath({ path: '/sales/:id', end: true }, location.pathname);
  const salesId = salesMatch?.params?.id;
  const salesQuery = useSalesOrder(salesId ?? '', Boolean(salesId && salesId !== 'new'));

  const labels: BreadcrumbLabelMap = useMemo(
    () => ({
      rfqNumber: rfqQuery.data?.rfqNumber,
      salesOrderNumber: salesQuery.data?.soNumber,
    }),
    [rfqQuery.data?.rfqNumber, salesQuery.data?.soNumber],
  );

  return useMemo(() => {
    const searchParams = new URLSearchParams(location.search);
    for (const route of breadcrumbRoutes) {
      const match = matchPath({ path: route.path, end: true }, location.pathname);
      if (!match) continue;
      const ctx = { homeHref, params: match.params, searchParams, labels };
      const built = route.buildItems(ctx);
      return {
        // Crumbs for a module's list page use the organisation's own name for it, if set.
        items: built.map((item, i) => {
          const target = item.href ?? (i === built.length - 1 ? location.pathname : undefined);
          const label = target ? customLabel(target) : undefined;
          return label ? { ...item, label } : item;
        }),
        subtitle: route.subtitle ? route.subtitle(ctx) : undefined,
      };
    }
    return { items: [], subtitle: undefined };
  }, [customLabel, homeHref, labels, location.pathname, location.search]);
}
