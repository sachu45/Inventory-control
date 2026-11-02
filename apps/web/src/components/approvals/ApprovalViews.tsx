import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from '@/components/ui/icons';
import { StatusBadge } from '@/components/shared/status-badge';
import { type ApprovalRequest, type ApprovalStatus } from '@/hooks/use-approvals';

const stages: ApprovalStatus[] = ['PENDING', 'APPROVED', 'REJECTED'];
export function ApprovalBoard({ rows, onSelect, onDecision }: { rows: ApprovalRequest[]; onSelect: (row: ApprovalRequest) => void; onDecision: (row: ApprovalRequest, target: ApprovalStatus) => void }) {
  const [dragging, setDragging] = useState<string | null>(null);
  return <div><p className="erp-view-note">Drag a pending request to Approved or Rejected, then review and confirm. You can also open a request to make your decision.</p>
    <div className="erp-approval-board">{stages.map(stage => <section key={stage} className={dragging && stage !== 'PENDING' ? 'approval-drop-ready' : ''} aria-label={`${stage.toLowerCase()} requests`}
      onDragOver={event => { if (dragging && stage !== 'PENDING') { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
      onDrop={event => { event.preventDefault(); const row = rows.find(item => item.id === event.dataTransfer.getData('text/plain')); setDragging(null); if (row?.status === 'PENDING' && stage !== 'PENDING') onDecision(row, stage); }}>
      <header><h2>{stage.toLowerCase()}</h2><span>{rows.filter(row => row.status === stage).length}</span></header>
      <div>{rows.filter(row => row.status === stage).map(row => <button type="button" key={row.id} className="approval-board-record" draggable={row.status === 'PENDING'} onDragStart={event => { event.dataTransfer.setData('text/plain', row.id); event.dataTransfer.effectAllowed = 'move'; setDragging(row.id); }} onDragEnd={() => setDragging(null)} onClick={() => onSelect(row)}>
        <small>{row.approvalType.replaceAll('_', ' ')}</small><strong>{row.documentNumber ?? 'Approval request'}</strong><p>{row.description || 'Open to review the document and its details.'}</p>
        <footer><span>{row.amount == null ? 'No amount specified' : new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:0 }).format(row.amount)}</span><span>{row.requiredAt ? 'Due ' + new Date(row.requiredAt).toLocaleDateString('en-IN', { day:'numeric', month:'short' }) : 'No due date'}</span></footer>
      </button>)}{!rows.some(row => row.status === stage) && <p className="erp-board-empty">No {stage.toLowerCase()} requests in these results.</p>}</div>
    </section>)}</div>
  </div>;
}

function dateKey(date: Date) { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
export function ApprovalCalendar({ rows, onSelect }: { rows: ApprovalRequest[]; onSelect: (row: ApprovalRequest) => void }) {
  const [mode, setMode] = useState<'month' | 'week' | 'day'>('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const days = useMemo(() => {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), mode === 'month' ? 1 : anchor.getDate());
    if (mode !== 'day') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    return Array.from({ length:mode === 'month' ? 42 : mode === 'week' ? 7 : 1 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  }, [anchor, mode]);
  function move(direction: number) { setAnchor(current => mode === 'month' ? new Date(current.getFullYear(), current.getMonth() + direction, 1) : new Date(current.getFullYear(), current.getMonth(), current.getDate() + direction * (mode === 'week' ? 7 : 1))); }
  const unscheduled = rows.filter(row => !row.requiredAt).length;
  return <section className="erp-calendar" aria-label="Approval due dates">
    <div className="erp-calendar-toolbar"><div className="flex items-center gap-2"><Button variant="ghost" size="icon" aria-label="Previous calendar period" onClick={() => move(-1)}><ChevronLeft /></Button><h2>{anchor.toLocaleDateString('en-IN', { month:'long', year:'numeric', ...(mode === 'day' ? { day:'numeric' as const } : {}) })}</h2><Button variant="ghost" size="icon" aria-label="Next calendar period" onClick={() => move(1)}><ChevronRight /></Button><Button variant="outline" size="sm" onClick={() => setAnchor(new Date())}>Today</Button></div>
      <div className="erp-view-switch" aria-label="Calendar period">{(['month','week','day'] as const).map(view => <button type="button" key={view} aria-pressed={mode === view} onClick={() => setMode(view)}>{view}</button>)}</div>
    </div>
    <p className="erp-view-note">Due dates for these results. {unscheduled} request{unscheduled === 1 ? '' : 's'} without a due date {unscheduled === 1 ? 'is' : 'are'} not shown on the calendar.</p>
    <div className={`erp-calendar-grid calendar-${mode}`}>
      {days.map(day => <div key={dateKey(day)} className={day.getMonth() !== anchor.getMonth() && mode === 'month' ? 'outside-month' : ''}>
        <time dateTime={day.toISOString()} className={dateKey(day) === dateKey(new Date()) ? 'calendar-today' : ''}>{day.toLocaleDateString('en-IN', { weekday:'short', day:'numeric' })}</time>
        {rows.filter(row => row.requiredAt && dateKey(new Date(row.requiredAt)) === dateKey(day)).map(row => <button type="button" key={row.id} onClick={() => onSelect(row)}><strong>{row.documentNumber ?? 'Approval'}</strong><StatusBadge compact status={row.status} /></button>)}
      </div>)}
    </div>
  </section>;
}
