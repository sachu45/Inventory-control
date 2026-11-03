import type { ElementType } from 'react';
import { AnimatedNumber } from '@/components/motion';
import { Skeleton } from '@/components/ui/skeleton';
import { type KpiTrend } from '@/lib/kpi-trend';
export type KpiAccent = 'indigo' | 'sky' | 'emerald' | 'amber' | 'violet' | 'rose';
export type DashboardKpiCardProps = {
 label: string; numericValue: number; format?: (value: number) => string; context?: string; trend?: KpiTrend;
 icon: ElementType; accent?: KpiAccent; ariaLabel: string; tooltip?: string; onClick: () => void;
};
export function DashboardKpiCard({ label, numericValue, format, context, trend, icon: Icon, ariaLabel, tooltip, onClick }: DashboardKpiCardProps) {
 return <button type="button" className="metric-display focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary" onClick={onClick} aria-label={ariaLabel} title={tooltip}>
 <span className="metric-label">{label}<Icon size={17} /></span>
 <AnimatedNumber value={numericValue} format={format} className="metric-number" />
 <span className="metric-caption">{trend ? `${trend.label} · ` : ''}{context ?? 'View detailed report'}</span>
 </button>;
}
export function DashboardKpiCardSkeleton() {
 return <div className="metric-display" aria-label="Loading metric"><Skeleton className="h-3 w-24" /><Skeleton className="my-4 h-8 w-20" /><Skeleton className="h-3 w-32" /></div>;
}
