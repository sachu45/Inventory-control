import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiErrorInfo } from '@/lib/api';
import { configApi, platformApi, type ConfigLayer } from '@/lib/platform-api';

const layerTone: Record<ConfigLayer, string> = {
  registry: 'bg-slate-100 text-slate-600',
  company: 'bg-sky-100 text-sky-800',
  shop: 'bg-violet-100 text-violet-800',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Why is this value set?": the live config as a request would resolve it, with the layer behind each value. */
export function EffectivePage() {
  const { companyId = '' } = useParams();
  const tenant = useQuery({ queryKey: ['tenant', companyId], queryFn: () => platformApi.getTenant(companyId) });
  const [shopId, setShopId] = useState('');
  const [userInput, setUserInput] = useState('');
  const userId = UUID.test(userInput.trim()) ? userInput.trim() : '';
  const effective = useQuery({
    queryKey: ['effective', companyId, shopId, userId],
    queryFn: () => configApi.effective(companyId, { shopId, userId }),
  });

  const data = effective.data;
  const usable = new Set(data?.user?.usableModules ?? []);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="space-y-1">
          <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">Shop</span>
          <select className="rounded-md border border-slate-300 px-2 py-1.5" value={shopId} onChange={(e) => setShopId(e.target.value)}>
            <option value="">Company-wide</option>
            {tenant.data?.shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.shopName}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">As user (ID, optional)</span>
          <input
            className="w-80 rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs"
            placeholder="User UUID to check plan + permissions"
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
          />
        </label>
        {data && <span className="pb-2 text-slate-600">Live version: {data.config.version === 0 ? 'registry defaults' : `v${data.config.version}`}</span>}
      </div>

      {effective.isError && <p role="alert" className="text-sm text-red-700">{apiErrorInfo(effective.error).message}</p>}
      {data?.user && (
        <p className="text-sm text-slate-600">
          {data.user.email} ({data.user.role}) can use {data.user.usableModules.length} modules.
        </p>
      )}

      <div className="flex gap-3 text-xs">
        {(Object.keys(layerTone) as ConfigLayer[]).map((layer) => (
          <span key={layer} className={clsx('rounded px-1.5 py-0.5', layerTone[layer])}>
            set by {layer}
          </span>
        ))}
      </div>

      {data && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Module</th>
                <th className="px-4 py-2">Enabled</th>
                <th className="px-4 py-2">Settings</th>
                {data.user && <th className="px-4 py-2">Usable by user</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {Object.entries(data.config.modules).map(([key, mod]) => (
                <tr key={key} className="align-top">
                  <td className="px-4 py-2 font-medium">{key}</td>
                  <td className="px-4 py-2">
                    {mod.enabled ? 'On' : 'Off'} <Layer layer={data.config.provenance[`${key}.enabled`]} />
                  </td>
                  <td className="px-4 py-2">
                    <ul className="space-y-0.5 font-mono text-xs">
                      {Object.entries(mod.config).map(([field, value]) => (
                        <li key={field}>
                          {field}: {JSON.stringify(value)} <Layer layer={data.config.provenance[`${key}.config.${field}`]} />
                        </li>
                      ))}
                    </ul>
                  </td>
                  {data.user && <td className="px-4 py-2">{usable.has(key) ? 'Yes' : 'No'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Layer({ layer }: { layer: ConfigLayer | undefined }) {
  if (!layer) return null;
  return <span className={clsx('ml-1 rounded px-1 py-0.5 font-sans text-[10px]', layerTone[layer])}>{layer}</span>;
}
