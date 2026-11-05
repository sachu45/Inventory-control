import { describe, expect, it } from 'vitest';
import { approvalDeepLink, type ApprovalRequest } from './use-approvals';
describe('approval record links', () => {
  it.each([
    ['GOODS_RECEIPT', '/goods-receipts?record=doc-1'],
    ['PURCHASE_ORDER', '/purchase-orders?record=doc-1'],
    ['GOODS_ISSUE', '/goods-issues?record=doc-1'],
    ['SALES_ORDER', '/sales/doc-1'],
  ])('opens an existing record route for %s', (approvalType, destination) => {
    expect(approvalDeepLink({ approvalType, referenceId:'doc-1' } as ApprovalRequest)).toBe(destination);
  });
});

it('links a workflow approval to invoices', () => {
  expect(approvalDeepLink({ approvalType: 'INVOICE_DUNNING', referenceId: 'i1' } as Parameters<typeof approvalDeepLink>[0])).toBe('/invoices');
});
