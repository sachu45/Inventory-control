import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import { INVOICE_DUNNING_GRAPH } from './default-workflows';
import type { WorkflowGraphDef } from './graph-types';
import { WorkflowRegistryService } from './workflow-registry.service';

const COMPANY = '11111111-1111-4111-8111-111111111111';

const GRAPH: WorkflowGraphDef = {
  key: 'k',
  name: 'n',
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

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

/** In-memory graph/version tables behind the subset of Prisma the registry uses. */
function setup() {
  const graphs: { id: string; companyId: string | null; key: string; name: string; latestVersion: number }[] = [];
  const versions: { id: string; graphId: string; version: number; status: string; document: unknown }[] = [];
  const failNext: Error[] = [];
  const tx = {
    workflowGraph: {
      findFirst: jest.fn(async ({ where }: { where: { companyId: string | null; key: string } }) =>
        graphs.find((g) => g.companyId === where.companyId && g.key === where.key) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Omit<(typeof graphs)[number], 'id'> }) => {
        const row = { ...data, id: `g${graphs.length + 1}` };
        graphs.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: { latestVersion: { increment: number }; name: string } }) => {
        const row = graphs.find((g) => g.id === where.id)!;
        row.latestVersion += data.latestVersion.increment;
        row.name = data.name;
        return { latestVersion: row.latestVersion };
      }),
    },
    workflowVersion: {
      create: jest.fn(async ({ data }: { data: Omit<(typeof versions)[number], 'id'> }) => {
        const next = failNext.shift();
        if (next) throw next;
        const row = { ...data, id: `v${versions.length + 1}` };
        versions.push(row);
        return row;
      }),
    },
    workflowNode: { createMany: jest.fn(async () => ({ count: 0 })) },
  };
  const prisma = {
    ...tx,
    workflowGraph: {
      ...tx.workflowGraph,
      findFirst: jest.fn(async ({ where }: { where: { companyId: string | null; key: string } }) => {
        const graph = graphs.find((g) => g.companyId === where.companyId && g.key === where.key);
        if (!graph) return null;
        const latest = versions.filter((v) => v.graphId === graph.id).sort((a, b) => b.version - a.version).slice(0, 1);
        return { ...graph, versions: latest };
      }),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const service = new WorkflowRegistryService(prisma as unknown as PrismaService);
  return { service, prisma, graphs, versions, failNext };
}

describe('WorkflowRegistryService.publish', () => {
  it('refuses an invalid graph with 422 WORKFLOW_INVALID and every compiler error', async () => {
    const { service, prisma } = setup();
    const bad = { ...GRAPH, nodes: [...GRAPH.nodes, { key: 'e2', kind: 'ENTRY' as const }] };
    const error = await service.publish(COMPANY, bad).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    const body = (error as UnprocessableEntityException).getResponse() as { code: string; details: { code: string }[] };
    expect(body.code).toBe('WORKFLOW_INVALID');
    expect(body.details.map((d) => d.code)).toContain('ENTRY_COUNT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a body that is not a graph with 422 instead of crashing', async () => {
    const { service } = setup();
    for (const body of [null, {}, { key: 'k', name: 'n', nodes: 'x', edges: [] }, { key: 'k', name: 'n', nodes: [1], edges: [{}] }]) {
      const error = await service.publish(COMPANY, body as unknown as WorkflowGraphDef).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      const details = ((error as UnprocessableEntityException).getResponse() as { details: { code: string }[] }).details;
      expect(details.every((d) => d.code === 'BAD_SHAPE')).toBe(true);
    }
  });

  it('numbers versions 1, 2, … per graph and never mutates an earlier one', async () => {
    const { service, versions } = setup();
    expect((await service.publish(COMPANY, GRAPH)).version).toBe(1);
    expect((await service.publish(COMPANY, { ...GRAPH, name: 'renamed' })).version).toBe(2);
    expect((await service.publish(null, GRAPH)).version).toBe(1);
    expect(versions.map((v) => [v.graphId, v.version])).toEqual([
      ['g1', 1],
      ['g1', 2],
      ['g2', 1],
    ]);
    expect((versions[0].document as WorkflowGraphDef).name).toBe('n');
  });

  it('retries a unique-key race once', async () => {
    const { service, failNext, prisma } = setup();
    failNext.push(uniqueViolation());
    await expect(service.publish(COMPANY, GRAPH)).resolves.toMatchObject({ version: expect.any(Number) });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('returns 409 when the race persists', async () => {
    const { service, failNext } = setup();
    failNext.push(uniqueViolation(), uniqueViolation());
    const error = await service.publish(COMPANY, GRAPH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(JSON.stringify((error as ConflictException).getResponse())).toContain('WORKFLOW_PUBLISH_CONFLICT');
  });

  it('does not retry other database errors', async () => {
    const { service, failNext, prisma } = setup();
    failNext.push(new Error('connection lost'));
    await expect(service.publish(COMPANY, GRAPH)).rejects.toThrow('connection lost');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('WorkflowRegistryService.getPublished', () => {
  it("prefers the company's graph, falls back to the system default, and sees a new publish at once", async () => {
    const { service } = setup();
    expect(await service.getPublished(COMPANY, INVOICE_DUNNING_GRAPH.key)).toBeNull();

    await service.publish(null, INVOICE_DUNNING_GRAPH);
    expect(await service.getPublished(COMPANY, INVOICE_DUNNING_GRAPH.key)).toMatchObject({ graphId: 'g1', version: 1 });

    // The cached system fallback is dropped when the company publishes its own.
    await service.publish(COMPANY, INVOICE_DUNNING_GRAPH);
    expect(await service.getPublished(COMPANY, INVOICE_DUNNING_GRAPH.key)).toMatchObject({ graphId: 'g2', version: 1 });
  });
});
