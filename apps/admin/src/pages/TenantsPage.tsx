import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '@/components/StatusBadge';
import { errorMessage } from '@/lib/api';
import { platformApi } from '@/lib/platform-api';

export function TenantsPage() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    const id = setTimeout(() => {
      setDebounced(search.trim());
      setCursors([undefined]);
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  const query = useQuery({
    queryKey: ['tenants', debounced, cursor],
    queryFn: () => platformApi.listTenants({ search: debounced, cursor }),
    placeholderData: keepPreviousData,
  });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Tenants</h1>
          <p className="text-sm text-slate-500">Every company on the platform, newest first.</p>
        </div>
        <input
          type="search"
          aria-label="Search tenants"
          placeholder="Search by name or code"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-72 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
      </div>

      {query.isError ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage(query.error)}
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Subscription</th>
                <th className="px-4 py-3">Config</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {query.isPending && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    Loading tenants…
                  </td>
                </tr>
              )}
              {query.data?.items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    {debounced ? `No tenants match “${debounced}”.` : 'No tenants yet.'}
                  </td>
                </tr>
              )}
              {query.data?.items.map((tenant) => (
                <tr key={tenant.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link to={`/tenants/${tenant.id}`} className="font-medium text-slate-900 hover:underline">
                      {tenant.companyName}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {tenant.companyCode}
                      {!tenant.isActive && ' · inactive'}
                    </div>
                  </td>
                  <td className="px-4 py-3">{tenant.subscriptionPlan}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={tenant.subscriptionStatus} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {tenant.activeConfig ? `v${tenant.activeConfig.version}` : 'Defaults'}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{new Date(tenant.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex justify-end gap-2 text-sm">
        <button
          type="button"
          disabled={cursors.length === 1}
          onClick={() => setCursors((c) => c.slice(0, -1))}
          className="rounded-md border border-slate-300 px-3 py-1.5 disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!query.data?.meta.hasMore}
          onClick={() => setCursors((c) => [...c, query.data?.meta.nextCursor ?? undefined])}
          className="rounded-md border border-slate-300 px-3 py-1.5 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </section>
  );
}
