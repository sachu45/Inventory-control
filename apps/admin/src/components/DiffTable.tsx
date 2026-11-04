import type { ConfigChange } from '@/lib/platform-api';

const show = (value: unknown) => (value === undefined ? '—' : JSON.stringify(value));

export function DiffTable({ changes, empty }: { changes: ConfigChange[]; empty: string }) {
  if (changes.length === 0) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">Setting</th>
            <th className="px-4 py-2">Before</th>
            <th className="px-4 py-2">After</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 font-mono text-xs">
          {changes.map((change) => (
            <tr key={change.path}>
              <td className="px-4 py-2">{change.path}</td>
              <td className="px-4 py-2 text-red-700">{show(change.before)}</td>
              <td className="px-4 py-2 text-emerald-700">{show(change.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
