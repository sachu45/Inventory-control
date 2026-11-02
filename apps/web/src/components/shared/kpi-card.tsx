import type { ReactNode } from 'react';
export type KpiCardProps = { label: string; value: ReactNode; accent: string; icon: ReactNode };
/** Compact ERP summary, shared by the operational list views. */
export function KpiCard({ label, value, icon }: KpiCardProps) {
  return <div className="erp-summary-metric"><div><span>{label}</span><strong>{value}</strong></div><span aria-hidden="true">{icon}</span></div>;
}
