import { randomUUID } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { GraphDunningExecutor } from '../src/common/workflow-engine/graph/graph-dunning-executor.service';
import { FeatureFlagsService } from '../src/common/workflow-engine/ops/feature-flags.service';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed, login, unwrap } from './helpers/e2e-http';
import { seedWorkflowMasterData, type WorkflowContext } from './helpers/workflow-fixture';

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@retailims.com';
const PASSWORD = 'E2eApprove@123';
const KEY = 'invoice-dunning';

const notify = (key: string) => ({ key, kind: 'ACTION', action: { type: 'notify.customer', channel: 'EMAIL', tone: 'friendly' } });

/** Reminds, waits for a person, then sends a final notice only if approved. */
const approvalGraph = (name = 'Approve final notice') => ({
  name,
  nodes: [
    { key: 'start', kind: 'ENTRY' },
    notify('first-notice'),
    { key: 'ask', kind: 'ACTION', action: { type: 'approval', params: { approverRole: 'OWNER', description: 'Send the final notice?' } } },
    { key: 'decided', kind: 'CONDITION', condition: { type: 'approvalReceived' } },
    notify('final-notice'),
    { key: 'sent', kind: 'TERMINAL', terminalReason: 'final-sent' },
    { key: 'declined', kind: 'TERMINAL', terminalReason: 'declined' },
  ],
  edges: [
    { from: 'start', to: 'first-notice' },
    { from: 'first-notice', to: 'ask' },
    { from: 'ask', to: 'decided' },
    { from: 'decided', to: 'final-notice', when: true },
    { from: 'decided', to: 'declined', when: false },
    { from: 'final-notice', to: 'sent' },
  ],
});

/** A real wait for a person's decision, through the real dunning sweep and approvals API. */
describe('Workflow approval step (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  const previousAllowlist = process.env.PLATFORM_ADMIN_EMAILS;
  jest.setTimeout(120_000);

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    adminToken = (await login(app)).accessToken;
  });

  afterAll(async () => {
    if (!E2E_DB_ENABLED) return;
    process.env.PLATFORM_ADMIN_EMAILS = previousAllowlist;
    await app.close();
  });

  const admin = () => authed(app, adminToken);
  const asTenant = <T>(companyId: string, fn: () => Promise<T>) =>
    TenantContext.run({ companyId, inRLSTx: false, systemAccess: false }, async () => await fn());
  const sweep = () => TenantContext.runWithSystemAccess(async () => await app.get(GraphDunningExecutor).sweep());
  const workflowsUrl = (companyId: string) => `/api/v1/platform/tenants/${companyId}/workflows`;

  const setup = async (graph: Record<string, unknown> = approvalGraph()) => {
    const tenant = await seedWorkflowMasterData(app);
    await asTenant(tenant.companyId, () => app.get(FeatureFlagsService).setEnabled(tenant.companyId, 'graph-execution', true));
    const res = await admin().post(workflowsUrl(tenant.companyId)).send({ ...graph, key: KEY }).expect(201);
    return { tenant, workflow: unwrap<{ id: string; warnings: string[] }>(res.body) };
  };

  const dueThread = async (tenant: WorkflowContext, totalValue = 500) => {
    const invoice = unwrap<{ id: string }>(
      (await authed(app, tenant.token).post('/api/v1/invoices').send({ shopId: tenant.shopId, customerId: tenant.customerId, totalValue, dueDate: '2020-01-01' }).expect(201)).body,
    );
    await asTenant(tenant.companyId, () =>
      prisma.followupThread.create({
        data: { companyId: tenant.companyId, entityType: 'invoice', entityId: invoice.id, customerId: tenant.customerId, state: 'ACTIVE', nextActionAt: new Date(0) },
      }),
    );
    return invoice.id;
  };

  const thread = (companyId: string, invoiceId: string) =>
    asTenant(companyId, () => prisma.followupThread.findFirstOrThrow({ where: { entityId: invoiceId } }));
  const steps = (companyId: string, invoiceId: string) =>
    asTenant(companyId, () => prisma.outboxEvent.count({ where: { aggregateId: invoiceId, eventType: 'invoice.dunning-step' } }));
  const approvals = (companyId: string, invoiceId: string) =>
    asTenant(companyId, () => prisma.approvalRequest.findMany({ where: { referenceId: invoiceId } }));

  it('parks at the approval, asks the right person once, and does not advance until decided', async () => {
    if (!E2E_DB_ENABLED) return;
    const { tenant, workflow } = await setup();
    expect(workflow.warnings).toEqual([]);
    const invoice = await dueThread(tenant);

    await sweep();
    // The step before the approval ran; the one after it did not.
    expect(await steps(tenant.companyId, invoice)).toBe(1);
    expect(await thread(tenant.companyId, invoice)).toMatchObject({ state: 'WAITING_APPROVAL', currentNodeId: 'decided', nextActionAt: null, workflowVersion: 1 });
    const [request, ...others] = await approvals(tenant.companyId, invoice);
    expect(others).toEqual([]);
    expect(request).toMatchObject({ status: 'PENDING', assignedTo: tenant.user.id, approvalType: 'INVOICE_DUNNING', description: 'Send the final notice?' });

    // Further sweeps change nothing and don't ask again.
    await sweep();
    await sweep();
    expect(await steps(tenant.companyId, invoice)).toBe(1);
    expect(await approvals(tenant.companyId, invoice)).toHaveLength(1);
    expect((await thread(tenant.companyId, invoice)).state).toBe('WAITING_APPROVAL');

    // The approver is told, and sees it in their approvals.
    const inbox = await asTenant(tenant.companyId, () => prisma.notification.count({ where: { userId: tenant.user.id, referenceId: request.id } }));
    expect(inbox).toBe(1);
    const pending = unwrap<{ data: { id: string }[] }>((await authed(app, tenant.token).get('/api/v1/approvals').expect(200)).body);
    expect(JSON.stringify(pending)).toContain(request.id);
  });

  it('approving takes the yes branch on the next sweep', async () => {
    if (!E2E_DB_ENABLED) return;
    const { tenant } = await setup();
    const invoice = await dueThread(tenant);
    await sweep();
    const [request] = await approvals(tenant.companyId, invoice);

    await authed(app, tenant.token).post(`/api/v1/approvals/${request.id}/approve`).send({}).expect(200);
    await sweep();
    expect(await thread(tenant.companyId, invoice)).toMatchObject({ currentNodeId: 'sent', stopReason: 'graph:final-sent' });
    expect(await steps(tenant.companyId, invoice)).toBe(2);
    await sweep();
    expect(await steps(tenant.companyId, invoice)).toBe(2);
  });

  it('rejecting takes the no branch, and sends nothing further', async () => {
    if (!E2E_DB_ENABLED) return;
    const { tenant } = await setup();
    const invoice = await dueThread(tenant);
    await sweep();
    const [request] = await approvals(tenant.companyId, invoice);

    await authed(app, tenant.token).post(`/api/v1/approvals/${request.id}/reject`).send({ rejectionReason: 'Customer is negotiating' }).expect(200);
    await sweep();
    expect(await thread(tenant.companyId, invoice)).toMatchObject({ currentNodeId: 'declined', stopReason: 'graph:declined' });
    expect(await steps(tenant.companyId, invoice)).toBe(1);
  });

  it('only the assigned person can decide', async () => {
    if (!E2E_DB_ENABLED) return;
    const { tenant } = await setup();
    const invoice = await dueThread(tenant);
    await sweep();
    const [request] = await approvals(tenant.companyId, invoice);

    const salesRole = await prisma.role.findFirstOrThrow({ where: { name: RoleName.SALES } });
    const email = `sales-${randomUUID().slice(0, 8)}@e2e.local`;
    await prisma.user.create({ data: { name: 'Sales', email, passwordHash: await bcrypt.hash(PASSWORD, 4), roleId: salesRole.id, shopId: tenant.shopId, isActive: true } });
    const colleague = authed(app, (await login(app, email, PASSWORD)).accessToken);
    const refused = await colleague.post(`/api/v1/approvals/${request.id}/approve`).send({});
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const outsider = await seedWorkflowMasterData(app);
    const foreign = await authed(app, outsider.token).post(`/api/v1/approvals/${request.id}/approve`).send({});
    expect(foreign.status).toBeGreaterThanOrEqual(400);

    await sweep();
    expect((await thread(tenant.companyId, invoice)).state).toBe('WAITING_APPROVAL');
    expect(await steps(tenant.companyId, invoice)).toBe(1);
  });

  it('resumes on its pinned version after the workflow changes or is disabled', async () => {
    if (!E2E_DB_ENABLED) return;
    const { tenant, workflow } = await setup();
    const invoice = await dueThread(tenant);
    await sweep();
    const [request] = await approvals(tenant.companyId, invoice);

    const replacement = {
      name: 'Replacement',
      nodes: [{ key: 'start', kind: 'ENTRY' }, { key: 'other-end', kind: 'TERMINAL', terminalReason: 'other' }],
      edges: [{ from: 'start', to: 'other-end' }],
    };
    await admin().put(`${workflowsUrl(tenant.companyId)}/${workflow.id}`).send(replacement).expect(200);
    await admin().post(`${workflowsUrl(tenant.companyId)}/${workflow.id}/disable`).expect(200);

    await authed(app, tenant.token).post(`/api/v1/approvals/${request.id}/approve`).send({}).expect(200);
    await sweep();
    expect(await thread(tenant.companyId, invoice)).toMatchObject({ currentNodeId: 'sent', stopReason: 'graph:final-sent' });
  });

  it('closes a waiting thread when the invoice gets paid, and nobody needs to decide', async () => {
    if (!E2E_DB_ENABLED) return;
    const { tenant } = await setup();
    const invoice = await dueThread(tenant);
    await sweep();

    await asTenant(tenant.companyId, () => prisma.invoiceHeader.update({ where: { id: invoice }, data: { status: 'PAID', paidValue: 500 } }));
    await sweep();
    expect(await thread(tenant.companyId, invoice)).toMatchObject({ state: 'RESOLVED', stopReason: 'graph:paid-while-awaiting-approval' });
    expect(await steps(tenant.companyId, invoice)).toBe(1);
  });

  it('with no one to ask, the thread waits without sending anything or losing its place', async () => {
    if (!E2E_DB_ENABLED) return;
    const graph = approvalGraph();
    const nobody = { ...graph, nodes: graph.nodes.map((n) => (n.key === 'ask' ? { ...n, action: { type: 'approval', params: { approverRole: 'VENDOR' } } } : n)) };
    const { tenant } = await setup(nobody);
    const invoice = await dueThread(tenant);

    await sweep();
    await sweep();
    expect(await approvals(tenant.companyId, invoice)).toEqual([]);
    // Retried with the whole tick, so the notice before it isn't sent once per sweep.
    expect(await steps(tenant.companyId, invoice)).toBe(0);
    expect(await thread(tenant.companyId, invoice)).toMatchObject({ state: 'ACTIVE', currentNodeId: null });
  });

  it('refuses a graph where a rejection could carry on regardless', async () => {
    if (!E2E_DB_ENABLED) return;
    const tenant = await seedWorkflowMasterData(app);
    const graph = approvalGraph();
    const ungated = {
      ...graph,
      key: KEY,
      nodes: graph.nodes.filter((n) => n.key !== 'decided' && n.key !== 'declined'),
      edges: [
        { from: 'start', to: 'first-notice' },
        { from: 'first-notice', to: 'ask' },
        { from: 'ask', to: 'final-notice' },
        { from: 'final-notice', to: 'sent' },
      ],
    };
    const viaAdmin = await admin().post(workflowsUrl(tenant.companyId)).send(ungated).expect(422);
    expect(JSON.stringify(viaAdmin.body)).toContain('APPROVAL_NEEDS_GATE');
    const viaTenant = await authed(app, tenant.token).post(`/api/v1/workflow-engine/workflows/${KEY}/publish`).send(ungated).expect(422);
    expect(JSON.stringify(viaTenant.body)).toContain('APPROVAL_NEEDS_GATE');
    await admin().post(workflowsUrl(tenant.companyId)).send({ ...approvalGraph(), key: 'e2e-bad-role', nodes: approvalGraph().nodes.map((n) => (n.key === 'ask' ? { ...n, action: { type: 'approval', params: { approverRole: 'KING' } } } : n)) }).expect(422);
  });

  it('a rejection stops a stored graph that has no gate, rather than carrying on', async () => {
    if (!E2E_DB_ENABLED) return;
    const { tenant } = await setup();
    const invoice = await dueThread(tenant);
    await sweep();
    const [request] = await approvals(tenant.companyId, invoice);
    // As a graph saved before gates were required would be: park directly on an action node.
    await asTenant(tenant.companyId, () => prisma.followupThread.updateMany({ where: { entityId: invoice }, data: { currentNodeId: 'final-notice' } }));

    await authed(app, tenant.token).post(`/api/v1/approvals/${request.id}/reject`).send({ rejectionReason: 'No' }).expect(200);
    await sweep();
    expect(await thread(tenant.companyId, invoice)).toMatchObject({ state: 'STOPPED', stopReason: 'graph:approval-rejected' });
    expect(await steps(tenant.companyId, invoice)).toBe(1);
  });
});
