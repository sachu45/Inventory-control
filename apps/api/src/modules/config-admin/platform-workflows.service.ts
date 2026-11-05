import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { TenantContext } from '../../common/tenant/tenant-context';
import type { RequestUser } from '../../common/types/request-user';
import type { WorkflowGraphDef } from '../../common/workflow-engine/graph/graph-types';
import { WorkflowRegistryService } from '../../common/workflow-engine/graph/workflow-registry.service';
import { ActionRegistry } from '../../common/workflow-engine/plugins/action-registry';
import { ConditionRegistry } from '../../common/workflow-engine/plugins/condition-registry';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformAuditService } from '../platform/platform-audit.service';

/** The only graph the engine runs on its own today (GraphDunningExecutor). */
const EXECUTED_KEY = 'invoice-dunning';
/** The only action type that sweep carries out; others are logged and skipped. */
const EXECUTED_ACTIONS = new Set(['notify.customer']);
const KEY = /^[a-z0-9][a-z0-9-]{1,79}$/;
const KEY_MESSAGE = 'Must be 2-80 lowercase letters, digits or hyphens';

const graphBody = z.object({
  name: z.string().trim().min(1).max(200),
  nodes: z.array(z.record(z.string(), z.unknown())),
  edges: z.array(z.record(z.string(), z.unknown())),
});
const createBody = graphBody.extend({ key: z.string().regex(KEY, KEY_MESSAGE) });
const cloneBody = z.strictObject({
  targetCompanyId: z.uuid().optional(),
  key: z.string().regex(KEY, KEY_MESSAGE).optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

function parsed<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new UnprocessableEntityException({
    code: 'WORKFLOW_INVALID',
    message: 'Invalid workflow',
    details: result.error.issues.map((issue) => ({ code: 'SHAPE', message: `${issue.path.join('.')}: ${issue.message}` })),
  });
}

type GraphRow = Prisma.WorkflowGraphGetPayload<{ include: { versions: true } }>;
const LATEST = { versions: { orderBy: { version: 'desc' as const } } };

/**
 * Platform-admin management of a tenant's workflow graphs (#169) over the existing
 * registry and compiler. Every graph is compiled before it is saved, each save is a new
 * immutable version, and running threads stay on the version they started on.
 */
@Injectable()
export class PlatformWorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: WorkflowRegistryService,
    private readonly actions: ActionRegistry,
    private readonly conditions: ConditionRegistry,
    private readonly platformAudit: PlatformAuditService,
  ) {}

  /** The tenant's graphs, plus the system defaults they can clone or override. */
  list(companyId: string) {
    return this.inTenant(companyId, async () => {
      const rows = await this.prisma.workflowGraph.findMany({
        where: { OR: [{ companyId }, { companyId: null }] },
        include: LATEST,
        orderBy: { key: 'asc' },
      });
      return rows.map((row) => this.view(row));
    });
  }

  create(companyId: string, body: unknown, actor: RequestUser) {
    const input = parsed(createBody.safeParse(body));
    return this.inTenant(companyId, async () => {
      await this.assertKeyFree(companyId, input.key);
      return this.save(companyId, input as unknown as WorkflowGraphDef, actor, 'created');
    });
  }

  update(companyId: string, id: string, body: unknown, actor: RequestUser) {
    const input = parsed(graphBody.safeParse(body));
    return this.inTenant(companyId, async () => {
      const graph = await this.ownGraph(companyId, id);
      if (!this.isEnabled(graph)) {
        throw new ConflictException({ code: 'WORKFLOW_DISABLED', message: 'Enable this workflow before changing it: saving would put it live' });
      }
      return this.save(companyId, { ...input, key: graph.key } as unknown as WorkflowGraphDef, actor, 'updated');
    });
  }

  /**
   * Disabling archives the published versions, so the tenant has no workflow under this key:
   * new runs don't start, and it does not fall back to the system default. Threads already
   * running keep their pinned version, because they load it by number. Enabling publishes the
   * latest version again.
   */
  setEnabled(companyId: string, id: string, enabled: boolean, actor: RequestUser) {
    return this.inTenant(companyId, async () => {
      const graph = await this.ownGraph(companyId, id);
      if (this.isEnabled(graph) !== enabled) {
        await (enabled
          ? this.prisma.workflowVersion.update({ where: { id: graph.versions[0].id }, data: { status: 'PUBLISHED' } })
          : this.prisma.workflowVersion.updateMany({ where: { graphId: graph.id, status: 'PUBLISHED' }, data: { status: 'ARCHIVED' } }));
        this.registry.invalidateCache();
        await this.audit(actor, companyId, graph.id, graph.key, enabled ? 'enabled' : 'disabled', graph.latestVersion);
      }
      return this.view(await this.findGraph(graph.id));
    });
  }

  /** Copies the latest version of a graph, or a system default, into this or another company. */
  async clone(companyId: string, id: string, body: unknown, actor: RequestUser) {
    const input = parsed(cloneBody.safeParse(body ?? {}));
    const source = await this.inTenant(companyId, async () => {
      const graph = await this.prisma.workflowGraph.findFirst({
        where: { id, OR: [{ companyId }, { companyId: null }] },
        include: LATEST,
      });
      if (!graph || graph.versions.length === 0) throw new NotFoundException('Workflow not found');
      return graph;
    });
    const targetId = input.targetCompanyId ?? companyId;
    const key = input.key ?? source.key;
    return this.inTenant(targetId, async () => {
      await this.assertKeyFree(targetId, key);
      const document = source.versions[0].document as unknown as WorkflowGraphDef;
      const def = { ...document, key, name: input.name ?? source.name };
      return this.save(targetId, def, actor, `cloned from ${source.key}`);
    });
  }

  private async save(companyId: string, def: WorkflowGraphDef, actor: RequestUser, change: string) {
    this.assertKnownTypes(def);
    const published = await this.registry.publish(companyId, def);
    await this.audit(actor, companyId, published.graphId, def.key, change, published.version);
    return { ...this.view(await this.findGraph(published.graphId)), warnings: this.warnings(def) };
  }

  /**
   * The compiler checks the graph's shape only. An unknown condition quietly evaluates to
   * false and an unknown action does nothing, so a typo would fail silently at run time.
   */
  private assertKnownTypes(def: WorkflowGraphDef): void {
    const errors = (def.nodes ?? []).flatMap((node) => {
      if (node?.action?.type && !this.actions.has(node.action.type)) {
        return [{ code: 'UNKNOWN_ACTION', nodeKey: node.key, message: `Unknown action "${node.action.type}"` }];
      }
      if (node?.condition?.type && !this.conditions.has(node.condition.type)) {
        return [{ code: 'UNKNOWN_CONDITION', nodeKey: node.key, message: `Unknown condition "${node.condition.type}"` }];
      }
      return [];
    });
    if (errors.length) {
      throw new UnprocessableEntityException({ code: 'WORKFLOW_INVALID', message: `Cannot save workflow: it has ${errors.length} error(s)`, details: errors });
    }
  }

  /** What a valid graph won't do once saved, so nobody discovers it in production. */
  private warnings(def: WorkflowGraphDef): string[] {
    const warnings: string[] = [];
    if (def.key !== EXECUTED_KEY) {
      warnings.push(`Only "${EXECUTED_KEY}" runs automatically today. This workflow can be simulated, but nothing starts it.`);
    }
    for (const node of def.nodes) {
      if (node.action?.type && !EXECUTED_ACTIONS.has(node.action.type)) {
        warnings.push(`Node "${node.key}": the "${node.action.type}" action is skipped when this runs; only notify.customer is carried out.`);
      }
      if (node.condition?.type === 'approvalReceived') {
        warnings.push(`Node "${node.key}": nothing sets approvalReceived yet, so this always takes the "no" branch. To route to a person, use an ESCALATE node.`);
      }
    }
    return warnings;
  }

  private isEnabled(graph: GraphRow): boolean {
    return graph.versions.some((version) => version.status === 'PUBLISHED');
  }

  private view(graph: GraphRow) {
    const latest = graph.versions[0];
    return {
      id: graph.id,
      key: graph.key,
      name: graph.name,
      isSystem: graph.companyId === null,
      enabled: this.isEnabled(graph),
      latestVersion: graph.latestVersion,
      document: latest?.document ?? null,
      updatedAt: graph.updatedAt,
    };
  }

  private findGraph(id: string): Promise<GraphRow> {
    return this.prisma.workflowGraph.findUniqueOrThrow({ where: { id }, include: LATEST });
  }

  /** System defaults aren't the tenant's to change: clone one instead. */
  private async ownGraph(companyId: string, id: string): Promise<GraphRow> {
    const graph = await this.prisma.workflowGraph.findFirst({ where: { id, companyId }, include: LATEST });
    if (!graph) throw new NotFoundException('Workflow not found');
    return graph;
  }

  private async assertKeyFree(companyId: string, key: string): Promise<void> {
    if (await this.prisma.workflowGraph.findFirst({ where: { companyId, key }, select: { id: true } })) {
      throw new ConflictException({ code: 'WORKFLOW_EXISTS', message: `This company already has a workflow "${key}"; choose another key or update it` });
    }
  }

  private audit(actor: RequestUser, companyId: string, graphId: string, key: string, change: string, version: number) {
    return this.platformAudit.logPlatformAction({
      userId: actor.id,
      adminEmail: actor.email,
      companyId,
      action: 'platform_workflow_set',
      entityType: 'WorkflowGraph',
      entityId: graphId,
      recordCode: key,
      extra: { change, version },
    });
  }

  /** Runs `work` as the target company, so RLS scopes every query to it. */
  private inTenant<T>(companyId: string, work: () => Promise<T>): Promise<T> {
    return TenantContext.run({ companyId, inRLSTx: false, systemAccess: false }, async () => {
      const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!company) throw new NotFoundException('Company not found');
      return work();
    });
  }
}
