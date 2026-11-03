import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalBoard, ApprovalCalendar } from './ApprovalViews';
import type { ApprovalRequest } from '@/hooks/use-approvals';
afterEach(cleanup);
const row: ApprovalRequest = { id:'a1', companyId:'c1', requestedBy:'u1', assignedTo:'u2', approvalType:'PURCHASE_ORDER', referenceId:'po1', documentNumber:'PO-TEST', status:'PENDING', amount:250, requiredAt:new Date().toISOString(), createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
describe('approval business views', () => {
  it('opens a decision review on drop without pretending the status is saved', () => {
    const decide = vi.fn();
    render(<ApprovalBoard rows={[row]} onSelect={vi.fn()} onDecision={decide} />);
    let value = '';
    const transfer = { setData: (_type: string, text: string) => { value=text; }, getData: () => value, effectAllowed:'', dropEffect:'' };
    fireEvent.dragStart(screen.getByRole('button', { name:/PO-TEST/ }), { dataTransfer:transfer });
    fireEvent.drop(screen.getByRole('region', { name:'approved requests' }), { dataTransfer:transfer });
    expect(decide).toHaveBeenCalledWith(row, 'APPROVED');
    expect(screen.getByRole('region', { name:'pending requests' })).toHaveTextContent('PO-TEST');
  });
  it('offers keyboard-accessible review as an alternative to dragging', () => {
    const select = vi.fn(); render(<ApprovalBoard rows={[row]} onSelect={select} onDecision={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name:/PO-TEST/ }));
    expect(select).toHaveBeenCalledWith(row);
  });
  it('shows actual due dates and omits unscheduled requests from the calendar', () => {
    render(<ApprovalCalendar rows={[row, { ...row, id:'a2', documentNumber:'UNSCHEDULED', requiredAt:null }]} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name:/PO-TEST/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name:/UNSCHEDULED/ })).not.toBeInTheDocument();
    expect(screen.getByText(/1 request without a due date/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name:'day' }));
    expect(screen.getByRole('button', { name:'day' })).toHaveAttribute('aria-pressed', 'true');
  });
});
