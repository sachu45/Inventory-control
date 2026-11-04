import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DiffTable } from '@/components/DiffTable';
import { apiErrorInfo } from '@/lib/api';
import { configApi } from '@/lib/platform-api';

export function VersionsPage() {
  const { companyId = '' } = useParams();
  const queryClient = useQueryClient();
  const versions = useQuery({ queryKey: ['versions', companyId], queryFn: () => configApi.listVersions(companyId) });
  const latest = versions.data?.[0]?.version ?? 0;
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);

  useEffect(() => {
    if (latest > 0) {
      setTo(latest);
      setFrom(latest - 1);
    }
  }, [latest]);

  const diff = useQuery({
    queryKey: ['diff', companyId, from, to],
    queryFn: () => configApi.diff(companyId, from, to),
    enabled: to > 0,
  });

  const rollback = useMutation({
    mutationFn: ({ version, note }: { version: number; note: string }) => configApi.rollback(companyId, version, latest, note),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['versions', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['drafts', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['tenant', companyId] });
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: ['versions', companyId] }),
  });

  if (versions.isPending) return <p className="text-slate-500">Loading versions…</p>;
  if (versions.isError) return <p role="alert" className="text-red-700">{apiErrorInfo(versions.error).message}</p>;
  if (versions.data.length === 0) return <p className="text-slate-500">Nothing published yet: this tenant runs on registry defaults.</p>;

  const options = [0, ...versions.data.map((v) => v.version).sort((a, b) => a - b)];
  const rollbackError = rollback.error ? apiErrorInfo(rollback.error) : null;

  return (
    <section className="space-y-6">
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2">Version</th>
              <th className="px-4 py-2">Published</th>
              <th className="px-4 py-2">Note</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {versions.data.map((v) => (
              <tr key={v.id}>
                <td className="px-4 py-2 font-medium">
                  v{v.version}
                  {v.version === latest && <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800">live</span>}
                </td>
                <td className="px-4 py-2 text-slate-600">{new Date(v.publishedAt).toLocaleString()}</td>
                <td className="px-4 py-2 text-slate-600">
                  {v.changeNote ?? '—'}
                  {v.sourceVersion !== null && <span className="ml-1 text-xs">(rollback of v{v.sourceVersion})</span>}
                </td>
                <td className="px-4 py-2 text-right">
                  {v.version !== latest && (
                    <button
                      type="button"
                      disabled={rollback.isPending}
                      onClick={() => {
                        const note = window.prompt(
                          `Roll back to v${v.version}? This publishes it again as v${latest + 1} and resets the drafts. Optional note:`,
                          '',
                        );
                        if (note !== null) rollback.mutate({ version: v.version, note: note.trim() });
                      }}
                      className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
                    >
                      Roll back to this
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rollback.isSuccess && (
        <p role="status" className="text-sm text-emerald-700">
          Rolled back: v{rollback.data.version.version} is now live.
        </p>
      )}
      {rollbackError && (
        <p role="alert" className="text-sm text-red-700">
          {rollbackError.status === 409 ? 'Someone published in the meantime; the list has been refreshed. Try again.' : rollbackError.message}
        </p>
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Compare</span>
          <select aria-label="Compare from" className="rounded-md border border-slate-300 px-2 py-1" value={from} onChange={(e) => setFrom(Number(e.target.value))}>
            {options.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? 'Registry defaults' : `v${v}`}
              </option>
            ))}
          </select>
          <span>with</span>
          <select aria-label="Compare to" className="rounded-md border border-slate-300 px-2 py-1" value={to} onChange={(e) => setTo(Number(e.target.value))}>
            {options.filter((v) => v > 0).map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </div>
        {diff.isError ? (
          <p role="alert" className="text-sm text-red-700">{apiErrorInfo(diff.error).message}</p>
        ) : (
          <DiffTable changes={diff.data ?? []} empty={diff.isPending ? 'Loading…' : 'No differences.'} />
        )}
      </div>
    </section>
  );
}
