import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { StatusBadge } from '@/components/StatusBadge';
import { errorMessage } from '@/lib/api';
import { platformApi } from '@/lib/platform-api';

export function TenantDetailPage() {
  const { companyId = '' } = useParams();
  const query = useQuery({ queryKey: ['tenant', companyId], queryFn: () => platformApi.getTenant(companyId) });

  if (query.isPending) return <p className="text-slate-500">Loading tenant…</p>;
  if (query.isError) {
    return (
      <div className="space-y-3">
        <Link to="/tenants" className="text-sm text-slate-600 hover:underline">
          ← All tenants
        </Link>
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage(query.error)}
        </p>
      </div>
    );
  }

  const tenant = query.data;
  return (
    <section className="space-y-6">
      <div>
        <Link to="/tenants" className="text-sm text-slate-600 hover:underline">
          ← All tenants
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{tenant.companyName}</h1>
        <p className="text-sm text-slate-500">
          {tenant.companyCode}
          {!tenant.isActive && ' · inactive'}
        </p>
      </div>

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
    </section>
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
