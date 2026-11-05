import { randomUUID } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { GraphDunningExecutor } from '../src/common/workflow-engine/graph/graph-dunning-executor.service';
import { FeatureFlagsService } from '../src/common/workflow-engine/ops/feature-flags.service';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed, login, unwrap } from './helpers/e2e-http';
import { seedWorkflowMasterData, type WorkflowContext } from './helpers/workflow-fixture';

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@retailims.com';
const DUNNING_KEY = 'invoice-dunning';

type Workflow = { id: string; key: string; name: string; isSystem: boolean; enabled: boolean; latestVersion: number; warnings?: string[] };

/** Large invoices go to Finance for approval; the rest get a customer reminder. */
const approvalGraph = (name = 'Finance approval') => ({
  name,
  nodes: [
    { key: 'start', kind: 'ENTRY' },
    { key: 'large', kind: 'CONDITION', condition: { type: 'amount.gte', params: { value: 50_000 } } },
    { key: 'finance', kind: 'ESCALATE', escalateTo: 'finance' },
    { key: 'remind', kind: 'ACTION', action: { type: 'notify.customer', channel: 'EMAIL', tone: 'friendly' } },
    { key: 'done-finance', kind: 'TERMINAL', terminalReason: 'sent-to-finance' },
    { key: 'done-reminded', kind: 'TERMINAL', terminalReason: 'reminded' },
  ],
  edges: [
    { from: 'start', to: 'large' },
    { from: 'large', to: 'finance', when: true },
    { from: 'large', to: 'remind', when: false },
    { from: 'finance', to: 'done-finance' },
    { from: 'remind', to: 'done-reminded' },
  ],
});

/** Platform workflow admin (#169): the API, and a company-specific workflow actually running. */
describe('Platform workflow admin (e2e)', () => {
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
  const url = (companyId: string) => `/api/v1/platform/tenants/${companyId}/workflows`;
  const create = async (companyId: string, body: Record<string, unknown>) =>
    unwrap<Workflow>((await admin().post(url(companyId)).send(body).expect(201)).body);
  const list = async (companyId: string) => unwrap<Workflow[]>((await admin().get(url(companyId)).expect(200)).body);
  const key = () => `e2e-${randomUUID().slice(0, 8)}`;

  it('compiles before saving: an invalid graph gets 422 with the compiler errors, and nothing is stored', async () => {
    if (!E2E_DB_ENABLED) return;
    const tenant = await seedWorkflowMasterData(app);
    const graph = approvalGraph();
    const badKey = key();

    const twoEntries = await admin().post(url(tenant.companyId)).send({ ...graph, key: badKey, nodes: [...graph.nodes, { key: 'e2', kind: 'ENTRY' }] }).expect(422);
    expect(JSON.stringify(twoEntries.body)).toContain('WORKFLOW_INVALID');
    expect(JSON.stringify(twoEntries.body)).toContain('ENTRY_COUNT');
    expect((await list(tenant.companyId)).map((w) => w.key)).not.toContain(badKey);

    await admin().post(url(tenant.companyId)).send({ key: badKey, name: 'x', nodes: 'nope', edges: [] }).expect(422);
    await admin().post(url(tenant.companyId)).send({ ...graph, key: 'Bad Key' }).expect(422);
    await admin().post(url(randomUUID())).send({ ...graph, key: key() }).expect(404);
  });

  it('refuses action and condition types the engine would silently ignore', async () => {
    if (!E2E_DB_ENABLED) return;
    const tenant = await seedWorkflowMasterData(app);
    const graph = approvalGraph();
    const swap = (nodeKey: string, patch: object) => graph.nodes.map((n) => (n.key === nodeKey ? { ...n, ...patch } : n));

    const condition = await admin().post(url(tenant.companyId)).send({ ...graph, key: key(), nodes: swap('large', { condition: { type: 'amount.typo' } }) }).expect(422);
    expect(JSON.stringify(condition.body)).toContain('UNKNOWN_CONDITION');
    const action = await admin().post(url(tenant.companyId)).send({ ...graph, key: key(), nodes: swap('remind', { action: { type: 'notify.typo' } }) }).expect(422);
    expect(JSON.stringify(action.body)).toContain('UNKNOWN_ACTION');
  });

  it('warns about valid graphs that will not do what they appear to', async () => {
    if (!E2E_DB_ENABLED) return;
    const tenant = await seedWorkflowMasterData(app);
    const graph = approvalGraph();
    const gated = {
      ...graph,
      key: key(),
      nodes: graph.nodes.map((n) => {
        if (n.key === 'remind') return { ...n, action: { type: 'crm.update' } };
        return n;
      }),
    };
    const { warnings } = await create(tenant.companyId, gated);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('runs automatically'),
        expect.stringContaining('"crm.update" action is skipped'),
      ]),
    );

    const clean = await create(tenant.companyId, { ...graph, key: DUNNING_KEY });
    expect(clean.warnings).toEqual([]);
  });

  it('versions updates, and manages only the tenant\'s own graphs', async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const b = await seedWorkflowMasterData(app);
    const graphKey = key();
    const made = await create(a.companyId, { ...approvalGraph(), key: graphKey });
    expect(made).toMatchObject({ key: graphKey, enabled: true, isSystem: false, latestVersion: 1 });

    await admin().post(url(a.companyId)).send({ ...approvalGraph(), key: graphKey }).expect(409);
    const updated = unwrap<Workflow>((await admin().put(`${url(a.companyId)}/${made.id}`).send(approvalGraph('Renamed')).expect(200)).body);
    expect(updated).toMatchObject({ key: graphKey, name: 'Renamed', latestVersion: 2 });
    await admin().put(`${url(a.companyId)}/${made.id}`).send({ ...approvalGraph(), nodes: [] }).expect(422);

    // Another tenant can neither see nor touch it, and system defaults are clone-only.
    expect((await list(b.companyId)).map((w) => w.id)).not.toContain(made.id);
    await admin().put(`${url(b.companyId)}/${made.id}`).send(approvalGraph()).expect(404);
    await admin().post(`${url(b.companyId)}/${made.id}/disable`).expect(404);
    const system = (await list(a.companyId)).find((w) => w.isSystem && w.key === DUNNING_KEY);
    expect(system).toBeDefined();
    await admin().put(`${url(a.companyId)}/${system!.id}`).send(approvalGraph()).expect(404);
    await admin().post(`${url(a.companyId)}/${system!.id}/disable`).expect(404);

    const audit = unwrap<{ items: { entityId: string; newValues: { platformAction?: string } | null }[] }>(
      (await admin().get(`/api/v1/platform/tenants/${a.companyId}/audit`).query({ type: 'config', take: 100 }).expect(200)).body,
    );
    expect(audit.items.find((row) => row.entityId === made.id)?.newValues?.platformAction).toBe('platform_workflow_set');
  });

  it('clones a graph or system default within and across companies', async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const b = await seedWorkflowMasterData(app);
    const graphKey = key();
    const source = await create(a.companyId, { ...approvalGraph(), key: graphKey });

    await admin().post(`${url(a.companyId)}/${source.id}/clone`).send({}).expect(409);
    const sameCompany = unwrap<Workflow>((await admin().post(`${url(a.companyId)}/${source.id}/clone`).send({ key: key(), name: 'Copy' }).expect(201)).body);
    expect(sameCompany).toMatchObject({ name: 'Copy', latestVersion: 1 });
    const otherCompany = unwrap<Workflow>((await admin().post(`${url(a.companyId)}/${source.id}/clone`).send({ targetCompanyId: b.companyId }).expect(201)).body);
    expect(otherCompany).toMatchObject({ key: graphKey, latestVersion: 1 });
    expect((await list(b.companyId)).map((w) => w.id)).toContain(otherCompany.id);
    await admin().post(`${url(a.companyId)}/${source.id}/clone`).send({ targetCompanyId: randomUUID() }).expect(404);
    await admin().post(`${url(b.companyId)}/${source.id}/clone`).send({ key: key() }).expect(404);

    const system = (await list(b.companyId)).find((w) => w.isSystem && w.key === DUNNING_KEY)!;
    const fromSystem = unwrap<Workflow>((await admin().post(`${url(b.companyId)}/${system.id}/clone`).send({}).expect(201)).body);
    expect(fromSystem).toMatchObject({ key: DUNNING_KEY, isSystem: false, enabled: true });
  });

  describe('running through the real dunning sweep', () => {
    const asTenant = <T>(companyId: string, fn: () => Promise<T>) =>
      TenantContext.run({ companyId, inRLSTx: false, systemAccess: false }, async () => await fn());

    /** An overdue invoice with a thread waiting to be picked up by the sweep. */
    const dueThread = async (tenant: WorkflowContext, totalValue: number) => {
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
    const stepsFor = (companyId: string, invoiceId: string) =>
      asTenant(companyId, () => prisma.outboxEvent.count({ where: { aggregateId: invoiceId, eventType: 'invoice.dunning-step' } }));

    it('a company-specific approval workflow routes each invoice its own way, and disabling stops new runs', async () => {
      if (!E2E_DB_ENABLED) return;
      const tenant = await seedWorkflowMasterData(app);
      await asTenant(tenant.companyId, () => app.get(FeatureFlagsService).setEnabled(tenant.companyId, 'graph-execution', true));
      const workflow = await create(tenant.companyId, { ...approvalGraph(), key: DUNNING_KEY });
      const sweep = () => TenantContext.runWithSystemAccess(async () => await app.get(GraphDunningExecutor).sweep());

      const large = await dueThread(tenant, 75_000);
      const small = await dueThread(tenant, 500);
      await sweep();

      // Each took its own branch, on this company's graph rather than the system default.
      const largeThread = await thread(tenant.companyId, large);
      const smallThread = await thread(tenant.companyId, small);
      expect(largeThread).toMatchObject({ currentNodeId: 'done-finance', stopReason: 'graph:sent-to-finance' });
      expect(smallThread).toMatchObject({ currentNodeId: 'done-reminded', stopReason: 'graph:reminded' });
      expect(await stepsFor(tenant.companyId, large)).toBe(1);
      expect(await stepsFor(tenant.companyId, small)).toBe(1);

      // Disabled: a new invoice isn't picked up, and doesn't fall back to the system default.
      await admin().post(`${url(tenant.companyId)}/${workflow.id}/disable`).expect(200);
      expect((await list(tenant.companyId)).find((w) => w.id === workflow.id)?.enabled).toBe(false);
      await admin().put(`${url(tenant.companyId)}/${workflow.id}`).send(approvalGraph()).expect(409);
      const waiting = await dueThread(tenant, 500);
      await sweep();
      expect(await thread(tenant.companyId, waiting)).toMatchObject({ state: 'ACTIVE', currentNodeId: null });
      expect(await stepsFor(tenant.companyId, waiting)).toBe(0);

      // Enabled again: the same invoice goes through, with no new version created.
      const enabled = unwrap<Workflow>((await admin().post(`${url(tenant.companyId)}/${workflow.id}/enable`).expect(200)).body);
      expect(enabled).toMatchObject({ enabled: true, latestVersion: 1 });
      await sweep();
      expect(await thread(tenant.companyId, waiting)).toMatchObject({ currentNodeId: 'done-reminded' });
      expect(await stepsFor(tenant.companyId, waiting)).toBe(1);
    });

    it('a thread already in progress finishes on its version when the workflow changes or is disabled', async () => {
      if (!E2E_DB_ENABLED) return;
      const tenant = await seedWorkflowMasterData(app);
      await asTenant(tenant.companyId, () => app.get(FeatureFlagsService).setEnabled(tenant.companyId, 'graph-execution', true));
      const waitFirst = {
        name: 'Wait first',
        nodes: [
          { key: 'start', kind: 'ENTRY' },
          { key: 'pause', kind: 'WAIT', waitHours: 1 },
          { key: 'remind', kind: 'ACTION', action: { type: 'notify.customer', channel: 'EMAIL', tone: 'friendly' } },
          { key: 'v1-end', kind: 'TERMINAL', terminalReason: 'v1' },
        ],
        edges: [
          { from: 'start', to: 'pause' },
          { from: 'pause', to: 'remind' },
          { from: 'remind', to: 'v1-end' },
        ],
      };
      const workflow = await create(tenant.companyId, { ...waitFirst, key: DUNNING_KEY });
      const sweep = () => TenantContext.runWithSystemAccess(async () => await app.get(GraphDunningExecutor).sweep());
      const invoice = await dueThread(tenant, 500);
      await sweep();
      expect((await thread(tenant.companyId, invoice)).state).toBe('ACTIVE');

      await admin().put(`${url(tenant.companyId)}/${workflow.id}`).send(approvalGraph()).expect(200);
      await admin().post(`${url(tenant.companyId)}/${workflow.id}/disable`).expect(200);
      await asTenant(tenant.companyId, () => prisma.followupThread.updateMany({ where: { entityId: invoice }, data: { nextActionAt: new Date(0) } }));
      await sweep();
      expect(await thread(tenant.companyId, invoice)).toMatchObject({ currentNodeId: 'v1-end', stopReason: 'graph:v1' });
    });
  });
});
