import { Link } from 'react-router-dom';
import { Lock } from '@/components/ui/icons';
import { useMeConfig } from '@/hooks/use-me-config';
import { moduleKeyForPath } from '@/lib/module-routes';
import { dashboardHomePath } from '@/lib/roles';
import { useAuthStore } from '@/store/authStore';
import type { SubscriptionSnapshot } from '@/lib/plans';

export type TrialFeature =
  | 'purchaseOrders'
  | 'reports'
  | 'rfqs'
  | 'contracts'
  | 'salesOrders'
  | 'salesQuotations'
  | 'invoices'
  | 'payments'
  | 'supplierPortal';

/** Plan feature flag -> module registry key. */
const FEATURE_MODULE: Record<TrialFeature, string> = {
  purchaseOrders: 'purchase-orders',
  reports: 'reports',
  rfqs: 'rfqs',
  contracts: 'contracts',
  salesOrders: 'sales',
  salesQuotations: 'sales-quotations',
  invoices: 'invoices',
  payments: 'payments',
  supplierPortal: 'supplier-portal',
};

type Props = {
  subscription?: SubscriptionSnapshot | null;
  /** Plan feature to check, as before; also identifies the module. */
  feature?: TrialFeature;
  /** Module registry key, for modules without a plan feature. */
  module?: string | null;
  children: React.ReactNode;
};

function planAllows(sub: SubscriptionSnapshot | null | undefined, feature: TrialFeature | undefined) {
  if (!feature || !sub) return true;
  if (sub.plan !== 'TRIAL') return true;
  const flags = sub.features ?? {};
  // If backend omitted the specific flag, default to false for trial.
  return Boolean((flags as Record<string, boolean | undefined>)[feature]);
}

/**
 * Gates a module page. Plan gating is unchanged (subscription flags, upgrade prompt).
 * On top of that, a module the organisation's published config switched off shows a
 * "not enabled" message with no upgrade prompt, since paying would not help.
 * Missing permissions are left to the existing route and API checks.
 */
export function FeatureGate({ subscription, feature, module, children }: Props) {
  const meConfig = useMeConfig();
  if (!planAllows(subscription, feature)) return <UpgradeRequired />;

  const key = module ?? (feature ? FEATURE_MODULE[feature] : null);
  if (key && meConfig?.modules[key]?.blockedBy === 'config') {
    return <ModuleDisabled moduleKey={key} label={meConfig.modules[key].label} />;
  }
  return <>{children}</>;
}

function GateCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="max-w-lg rounded-2xl border border-border bg-card p-6 text-center shadow-xs">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-primary">
          <Lock className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function UpgradeRequired() {
  return (
    <GateCard title="Upgrade to access this feature">
      <p className="mt-2 text-sm text-muted-foreground">
        This feature is not available on the trial. Subscribe to unlock it and keep all your existing data.
      </p>
      <Link
        to="/upgrade"
        className="mt-4 inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
      >
        Go to Upgrade
      </Link>
    </GateCard>
  );
}

function ModuleDisabled({ moduleKey, label }: { moduleKey: string; label: string }) {
  const role = useAuthStore((s) => s.user?.role);
  const home = dashboardHomePath(role);
  // A role whose home page is this very module would loop; send it to the tools hub.
  const target = moduleKeyForPath(home) === moduleKey ? '/tools' : home;
  return (
    <GateCard title="This module is not enabled for your organisation">
      <p className="mt-2 text-sm text-muted-foreground">
        {label} has been switched off in your organisation's configuration. Contact your administrator if you need it.
      </p>
      <Link
        to={target}
        className="mt-4 inline-flex items-center justify-center rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted"
      >
        Go to your home page
      </Link>
    </GateCard>
  );
}
