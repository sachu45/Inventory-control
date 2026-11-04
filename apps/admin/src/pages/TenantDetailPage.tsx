import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { StatusBadge } from '@/components/StatusBadge';
import { platformApi } from '@/lib/platform-api';

/** Overview tab; TenantLayout renders the header and handles loading and errors. */
export function TenantDetailPage() {
  const { companyId = '' } = useParams();
  const { data: tenant } = useQuery({ queryKey: ['tenant', companyId], queryFn: () => platformApi.getTenant(companyId) });
  if (!tenant) return null;

  return (
    <div className="space-y-6">
      <dl className="grid gap-4 sm:grid-cols-4">
        <Stat label="Plan">{tenant.subscriptionPlan}</Stat>
        <Stat label="Subscription">
          <StatusBadge status={tenant.subscriptionStatus} />
        </Stat>
        <Stat label="Published config">
          {tenant.activeConfig
            ? `v${tenant.activeConfig.version} · ${new Date(tenant.activeConfig.publishedAt).toLocaleDateString()}`
            : 'Registry defaults'}
        </Stat>
        <Stat label="Draft rows">{tenant.draftCount}</Stat>
      </dl>

      <div className="rounded-xl border border-slate-200 bg-white">
        <h2 className="border-b border-slate-200 px-4 py-3 font-medium">Plants ({tenant.shops.length})</h2>
        <ul className="divide-y divide-slate-100 text-sm">
          {tenant.shops.length === 0 && <li className="px-4 py-3 text-slate-500">No plants.</li>}
          {tenant.shops.map((shop) => (
            <li key={shop.id} className="flex items-center justify-between px-4 py-3">
              <span>
                {shop.shopName} <span className="text-slate-500">· {shop.shopNumber}</span>
              </span>
              {!shop.isActive && <span className="text-xs text-slate-500">inactive</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 font-medium">{children}</dd>
    </div>
  );
}
