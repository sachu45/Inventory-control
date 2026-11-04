import clsx from 'clsx';

const tone: Record<string, string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  SUSPENDED: 'bg-amber-50 text-amber-700 ring-amber-200',
  EXPIRED: 'bg-red-50 text-red-700 ring-red-200',
  CANCELLED: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={clsx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1', tone[status] ?? tone.CANCELLED)}>
      {status.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}
