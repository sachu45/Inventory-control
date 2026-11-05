import type { INestApplication } from '@nestjs/common';
import { WorkflowRegistryService } from '../src/common/workflow-engine/graph/workflow-registry.service';
import type { WorkflowGraphDef } from '../src/common/workflow-engine/graph/graph-types';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed, unwrap } from './helpers/e2e-http';
import { seedWorkflowMasterData } from './helpers/workflow-fixture';

const GRAPH: Omit<WorkflowGraphDef, 'key'> = {
  name: 'E2E publish',
  nodes: [
    { key: 'e', kind: 'ENTRY' },
    { key: 'a', kind: 'ACTION', action: { type: 'x' } },
    { key: 't', kind: 'TERMINAL', terminalReason: 'done' },
  ],
  edges: [
    { from: 'e', to: 'a' },
    { from: 'a', to: 't' },
  ],
};

/** Publishing a workflow graph: compile errors are 422, and concurrent publishes get distinct versions (#244). */
describe('Workflow publish (e2e)', () => {
  let app: INestApplication;
  jest.setTimeout(60_000);

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    app = await createE2eApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('refuses an invalid graph with 422 and the compiler errors', async () => {
    if (!E2E_DB_ENABLED) return;
    const ctx = await seedWorkflowMasterData(app);
    const api = authed(app, ctx.token);
    const key = `e2e-invalid-${Date.now()}`;

    const invalid = await api
      .post(`/api/v1/workflow-engine/workflows/${key}/publish`)
      .send({ ...GRAPH, nodes: [...GRAPH.nodes, { key: 'e2', kind: 'ENTRY' }] });
    expect(invalid.status).toBe(422);
    expect(JSON.stringify(invalid.body)).toContain('WORKFLOW_INVALID');
    expect(JSON.stringify(invalid.body)).toContain('ENTRY_COUNT');

    await api.post(`/api/v1/workflow-engine/workflows/${key}/publish`).send({ name: 'x', nodes: 'nope' }).expect(422);

    const ok = unwrap<{ version: number }>((await api.post(`/api/v1/workflow-engine/workflows/${key}/publish`).send(GRAPH).expect(201)).body);
    expect(ok.version).toBe(1);
  });

  it('gives concurrent publishes of one graph distinct, consecutive versions', async () => {
    if (!E2E_DB_ENABLED) return;
    const ctx = await seedWorkflowMasterData(app);
    const registry = app.get(WorkflowRegistryService);
    const prisma = app.get(PrismaService);
    const key = `e2e-race-${Date.now()}`;
    const asTenant = <T>(fn: () => Promise<T>) =>
      TenantContext.run({ companyId: ctx.companyId, inRLSTx: false, systemAccess: false }, async () => await fn());

    // The first publish creates the graph row; the rest race on the version number.
    await asTenant(() => registry.publish(ctx.companyId, { ...GRAPH, key }));
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => asTenant(() => registry.publish(ctx.companyId, { ...GRAPH, key, name: `v${i}` }))),
    );
    expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);

    const graph = await asTenant(() =>
      prisma.workflowGraph.findFirstOrThrow({ where: { companyId: ctx.companyId, key }, include: { versions: true } }),
    );
    expect(graph.latestVersion).toBe(7);
    expect(graph.versions.map((v) => v.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
