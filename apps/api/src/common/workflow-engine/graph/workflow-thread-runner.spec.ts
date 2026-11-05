import { advanceThread, ThreadFacts } from './workflow-thread-runner';
import { approvalGateErrors, compileWorkflow } from './workflow-compiler';
import { INVOICE_DUNNING_GRAPH } from './default-workflows';
import { CompiledWorkflow } from './graph-types';

function wf(): CompiledWorkflow {
  const r = compileWorkflow(INVOICE_DUNNING_GRAPH);
  if (!r.ok) throw new Error('fixture must compile');
  return r.workflow;
}

const unpaid: ThreadFacts = { invoicePaid: false, customerReplied: false };
const paid: ThreadFacts = { invoicePaid: true, customerReplied: false };
const now = new Date('2026-01-01T00:00:00Z');

describe('advanceThread', () => {
  it('first tick fires the pre-due reminder and parks at the first wait', () => {
    const adv = advanceThread(wf(), null, unpaid, now);
    expect(adv.effects).toHaveLength(1);
    expect(adv.effects[0]).toMatchObject({ kind: 'ACTION', nodeKey: 'pre-due' });
    expect(adv.park.kind).toBe('WAIT');
    if (adv.park.kind === 'WAIT') {
      expect(adv.park.nextNodeId).toBe('gate-1');
      expect(adv.park.resumeAt.getTime()).toBe(new Date('2026-01-04T00:00:00Z').getTime());
    }
  });

  it('resuming at a paid gate terminates with reason=paid and fires nothing', () => {
    const adv = advanceThread(wf(), 'gate-1', paid, now);
    expect(adv.effects).toHaveLength(0);
    expect(adv.park.kind).toBe('TERMINAL');
    if (adv.park.kind === 'TERMINAL') expect(adv.park.reason).toBe('paid');
  });

  it('resuming at a gate while unpaid fires the next reminder and parks again', () => {
    const adv = advanceThread(wf(), 'gate-1', unpaid, now);
    expect(adv.effects[0]).toMatchObject({ kind: 'ACTION', nodeKey: 'due-notice' });
    expect(adv.park.kind).toBe('WAIT');
  });

  it('drives through to escalation when the customer never pays', () => {
    // Walk the graph tick-by-tick from the start until it terminates.
    let cursor: string | null = null;
    const fired: string[] = [];
    let escalated = false;
    let reason = '';
    for (let i = 0; i < 20; i++) {
      const adv = advanceThread(wf(), cursor, unpaid, now);
      for (const e of adv.effects) {
        if (e.kind === 'ACTION') fired.push(e.nodeKey);
        if (e.kind === 'ESCALATE') escalated = true;
      }
      if (adv.park.kind === 'TERMINAL') {
        reason = adv.park.reason;
        break;
      }
      cursor = adv.park.nextNodeId;
    }
    expect(fired).toEqual(['pre-due', 'due-notice', 'firm-3', 'final-7']);
    expect(escalated).toBe(true);
    expect(reason).toBe('unresolved');
  });
});

describe('advanceThread at an approval', () => {
  const def = (afterApproval: string) => ({
    key: 'approval-test',
    name: 'Approval test',
    nodes: [
      { key: 'start', kind: 'ENTRY' as const },
      { key: 'notice', kind: 'ACTION' as const, action: { type: 'notify.customer' } },
      { key: 'ask', kind: 'ACTION' as const, action: { type: 'approval', params: { approverRole: 'ADMIN' } } },
      { key: 'gate', kind: 'CONDITION' as const, condition: { type: 'approvalReceived' } },
      { key: 'yes', kind: 'TERMINAL' as const, terminalReason: 'yes' },
      { key: 'no', kind: 'TERMINAL' as const, terminalReason: 'no' },
    ],
    edges: [
      { from: 'start', to: 'notice' },
      { from: 'notice', to: 'ask' },
      { from: 'ask', to: afterApproval },
      { from: 'gate', to: 'yes', when: true },
      { from: 'gate', to: 'no', when: false },
    ],
  });
  const compiled = () => {
    const r = compileWorkflow(def('gate'));
    if (!r.ok) throw new Error('fixture must compile');
    return r.workflow;
  };

  it('fires what comes before it, then parks on the next node with its params', () => {
    const adv = advanceThread(compiled(), null, unpaid, now);
    expect(adv.effects.map((e) => e.nodeKey)).toEqual(['notice']);
    expect(adv.park).toEqual({ kind: 'APPROVAL', nodeKey: 'ask', nextNodeId: 'gate', params: { approverRole: 'ADMIN' } });
  });

  it.each([
    [true, 'yes'],
    [false, 'no'],
  ])('resuming with approvalReceived=%s ends at %s', (approvalReceived, end) => {
    const adv = advanceThread(compiled(), 'gate', { ...unpaid, flags: { approvalReceived } }, now);
    expect(adv.effects).toEqual([]);
    expect(adv.park).toMatchObject({ kind: 'TERMINAL', nodeKey: end });
  });

  it('a graph must follow an approval with an approvalReceived gate', () => {
    expect(approvalGateErrors(def('gate'))).toEqual([]);
    expect(approvalGateErrors(def('yes'))).toEqual([expect.objectContaining({ code: 'APPROVAL_NEEDS_GATE', nodeKey: 'ask' })]);
    expect(approvalGateErrors(INVOICE_DUNNING_GRAPH)).toEqual([]);
  });
});
