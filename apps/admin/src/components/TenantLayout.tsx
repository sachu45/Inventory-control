import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import { errorMessage } from '@/lib/api';
import { platformApi } from '@/lib/platform-api';

const TABS: [string, string][] = [
  ['', 'Overview'],
  ['modules', 'Modules'],
  ['custom-fields', 'Custom fields'],
  ['publish', 'Preview & publish'],
  ['versions', 'Versions'],
  ['effective', 'Effective config'],
];

export function TenantLayout() {
  const { companyId = '' } = useParams();
  const tenant = useQuery({ queryKey: ['tenant', companyId], queryFn: () => platformApi.getTenant(companyId) });

  return (
    <section className="space-y-5">
      <div>
        <Link to="/tenants" className="text-sm text-slate-600 hover:underline">
          ← All tenants
        </Link>
        {tenant.isError ? (
          <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage(tenant.error)}
          </p>
        ) : (
          <>
            <h1 className="mt-2 text-2xl font-semibold">{tenant.data?.companyName ?? 'Loading tenant…'}</h1>
            {tenant.data && (
              <p className="text-sm text-slate-500">
                {tenant.data.companyCode}
                {!tenant.data.isActive && ' · inactive'}
              </p>
            )}
          </>
        )}
      </div>
      {tenant.isSuccess && (
        <>
          <nav className="flex gap-1 border-b border-slate-200 text-sm">
            {TABS.map(([path, label]) => (
              <NavLink
                key={label}
                end={path === ''}
                to={path ? `/tenants/${companyId}/${path}` : `/tenants/${companyId}`}
                className={({ isActive }) =>
                  clsx(
                    '-mb-px border-b-2 px-3 py-2',
                    isActive ? 'border-slate-900 font-medium text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800',
                  )
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <Outlet />
        </>
      )}
    </section>
  );
}
