import { Injectable, Logger } from '@nestjs/common';
import { AlertType, ApprovalStatus, ApprovalType, InvoiceStatus, NotificationModule, NotificationPriority, Prisma, RoleName } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { OutboxService } from '../../event-platform/outbox.service';
import { FeatureFlagsService } from '../ops/feature-flags.service';
import { ConditionRegistry } from '../plugins/condition-registry';
import { WorkflowRegistryService } from './workflow-registry.service';
import { NotificationService } from '@/modules/notifications/services';
import { advanceThread, ThreadFacts } from './workflow-thread-runner';
import { graphActionToStepPayload, graphEscalateToStepPayload, StepContext } from './graph-step-payload';

const DUNNING_ENTITY_TYPE = 'invoice';
const WORKFLOW_KEY = 'invoice-dunning';
const DAY_MS = 86_400_000;
const DEFAULT_APPROVER_ROLE = RoleName.OWNER;

export interface GraphSweepResult {
  readonly companiesEnabled: number;
  readonly threadsAdvanced: number;
  readonly stepsEmitted: number;
  readonly resolved: number;
}

/**
 * Graph-driven dunning execution (Plan §6 — the keystone). The alternative to
 * the ladder sweep: instead of `DUNNING_LADDER[index]`, each active
 * FollowupThread is advanced through its pinned {@link WorkflowVersion} by
 * {@link advanceThread}, storing the parked node on `currentNodeId`. Every
 * ACTION emits the same `invoice.dunning-step` event the ladder does, so the
 * whole downstream dispatch pipeline is reused unchanged.
 *
 * Opt-in per tenant via the `graph-execution` feature flag (default off) so the
 * proven ladder sweep stays authoritative until a company chooses the graph.
 * Both must never run for the same tenant at once — see docs; enabling
 * graph-execution is the switch that hands a tenant over to the graph.
 */
const CUSTOMER_MESSAGE_ACTIONS = new Set(['notify.customer']);

@Injectable()
export class GraphDunningExecutor {
  private readonly logger = new Logger(GraphDunningExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly registry: WorkflowRegistryService,
    private readonly features: FeatureFlagsService,
    private readonly conditions: ConditionRegistry,
    private readonly notifications: NotificationService,
  ) {}

  async sweep(now: Date = new Date()): Promise<GraphSweepResult> {
    // Only tenants on graph-execution are swept, oldest due first, so threads
    // of other tenants can't fill the batch and starve everyone else.
    const companyFilter = await this.features.companyFilter('graph-execution');
    if ('in' in companyFilter && companyFilter.in.length === 0) {
      return { companiesEnabled: 0, threadsAdvanced: 0, stepsEmitted: 0, resolved: 0 };
    }
    const due = await this.prisma.followupThread.findMany({
      where: {
        entityType: DUNNING_ENTITY_TYPE,
        state: 'ACTIVE',
        companyId: companyFilter,
        OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }],
      },
      orderBy: [{ nextActionAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: 500,
    });
    const waiting = await this.prisma.followupThread.findMany({
      where: { entityType: DUNNING_ENTITY_TYPE, state: 'WAITING_APPROVAL', companyId: companyFilter },
      orderBy: { updatedAt: 'asc' },
      take: 500,
    });
    const decisions = await this.latestDecisions([...due, ...waiting].map((t) => t.entityId));
    let resolvedWhileWaiting = 0;
    const decided: typeof waiting = [];
    for (const thread of waiting) {
      const facts = await this.loadFacts(thread.entityId);
      if (facts?.threadFacts.invoicePaid) {
        await this.prisma.followupThread.update({
          where: { id: thread.id },
          data: { state: 'RESOLVED', nextActionAt: null, stopReason: 'graph:paid-while-awaiting-approval' },
        });
        resolvedWhileWaiting += 1;
      } else if (decisions.get(thread.entityId) !== undefined) {
        decided.push(thread);
      }
    }
    const runnable = [...due, ...decided];

    // Resolve each distinct company's flag once (also honours the flag cache).
    const flagByCompany = new Map<string, boolean>();
    for (const companyId of new Set(runnable.map((t) => t.companyId))) {
      flagByCompany.set(companyId, await this.features.isEnabled(companyId, 'graph-execution'));
    }
    const companiesEnabled = [...flagByCompany.values()].filter(Boolean).length;

    let threadsAdvanced = 0;
    let stepsEmitted = 0;
    let resolved = resolvedWhileWaiting;

    for (const thread of runnable) {
      if (!flagByCompany.get(thread.companyId)) continue;

      const facts = await this.loadFacts(thread.entityId);
      if (!facts) continue; // invoice gone / not collectible → leave thread as-is
      // A thread already inside the graph stays on the version it started on;
      // only new threads pick up the latest published version.
      const published =
        (thread.currentNodeId
          ? await this.registry.getVersion(thread.companyId, WORKFLOW_KEY, thread.workflowVersion)
          : null) ?? (await this.registry.getPublished(thread.companyId, WORKFLOW_KEY));
      if (!published) continue;

      const approved = decisions.get(thread.entityId);
      const resuming = thread.state === 'WAITING_APPROVAL';
      // A rejection may only continue into a gate that handles it; a stored graph might not have one.
      const resumeNode = thread.currentNodeId ? published.workflow.nodes[thread.currentNodeId] : undefined;
      if (resuming && approved === false && !(resumeNode?.kind === 'CONDITION' && resumeNode.condition?.type === 'approvalReceived')) {
        await this.prisma.followupThread.update({
          where: { id: thread.id },
          data: { state: 'STOPPED', nextActionAt: null, stopReason: 'graph:approval-rejected' },
        });
        threadsAdvanced += 1;
        resolved += 1;
        continue;
      }
      const threadFacts: ThreadFacts = { ...facts.threadFacts, flags: { approvalReceived: approved === true } };
      const advance = advanceThread(published.workflow, thread.currentNodeId ?? null, threadFacts, now, {
        // Route CONDITION nodes through the pluggable registry so custom
        // conditions (officeHours, amount.gt, approvalReceived…) work live.
        evaluate: (spec, f, at) =>
          this.conditions.evaluate(spec, {
            invoicePaid: f.invoicePaid,
            customerReplied: f.customerReplied,
            now: at,
            amount: f.amount,
            daysOverdue: f.daysOverdue,
            flags: f.flags,
          }),
      });
      // Decide who to ask first: with nobody to ask, the whole tick waits for the next sweep,
      // so steps before the approval aren't sent again on each retry.
      const approverId = advance.park.kind === 'APPROVAL' ? await this.findApprover(thread.companyId, advance.park.params) : null;
      if (advance.park.kind === 'APPROVAL' && !approverId) {
        this.logger.warn(`No active approver for thread ${thread.id} at node ${advance.park.nodeKey}; retrying next sweep`);
        continue;
      }
      const ctx: StepContext = {
        invoiceId: thread.entityId,
        invoiceNumber: facts.invoiceNumber,
        customerId: thread.customerId,
        balanceDue: facts.balanceDue,
        daysFromDue: facts.daysFromDue,
      };

      const request = await this.prisma.$transaction(async (tx) => {
        for (const effect of advance.effects) {
          // Only customer-notify actions become dunning messages; other action
          // types (webhook, crm.update, ...) are not executed by this sweep.
          if (effect.kind === 'ACTION' && !CUSTOMER_MESSAGE_ACTIONS.has(effect.action.type)) {
            this.logger.warn(`Graph action ${effect.action.type} skipped for thread ${thread.id}`);
            continue;
          }
          const payload =
            effect.kind === 'ACTION' ? graphActionToStepPayload(effect.action, ctx) : graphEscalateToStepPayload(ctx);
          await this.outbox.emit(tx, {
            eventType: 'invoice.dunning-step',
            eventVersion: 1,
            aggregateType: 'invoice',
            aggregateId: thread.entityId,
            companyId: thread.companyId,
            payload: payload as unknown as Record<string, unknown>,
          });
          stepsEmitted += 1;
        }
        await tx.followupThread.update({
          where: { id: thread.id },
          data: this.parkToThreadData(advance.park, published.version),
        });
        if (advance.park.kind !== 'APPROVAL') return null;
        return tx.approvalRequest.create({
          data: {
            companyId: thread.companyId,
            requestedBy: facts.createdById ?? (approverId as string),
            assignedTo: approverId as string,
            approvalType: ApprovalType.INVOICE_DUNNING,
            referenceId: thread.entityId,
            documentNumber: facts.invoiceNumber,
            amount: facts.balanceDue,
            description: typeof advance.park.params?.description === 'string' ? advance.park.params.description : `Approval needed for ${facts.invoiceNumber}`,
            status: ApprovalStatus.PENDING,
          },
        });
      });
      if (request) await this.notifyApprover(request);

      threadsAdvanced += 1;
      if (advance.park.kind === 'TERMINAL') resolved += 1;
    }

    if (threadsAdvanced > 0) {
      this.logger.log(
        `Graph dunning: ${threadsAdvanced} threads advanced, ${stepsEmitted} steps emitted, ${resolved} resolved ` +
          `(${companiesEnabled} companies on graph-execution).`,
      );
    }
    return { companiesEnabled, threadsAdvanced, stepsEmitted, resolved };
  }

  private parkToThreadData(
    park: ReturnType<typeof advanceThread>['park'],
    version: number,
  ): Prisma.FollowupThreadUpdateInput {
    if (park.kind === 'APPROVAL') {
      return { currentNodeId: park.nextNodeId, nextActionAt: null, workflowVersion: version, state: 'WAITING_APPROVAL' };
    }
    if (park.kind === 'WAIT') {
      return { currentNodeId: park.nextNodeId, nextActionAt: park.resumeAt, workflowVersion: version, state: 'ACTIVE' };
    }
    // TERMINAL: map the graph reason onto a thread state.
    const state = park.reason === 'paid' ? 'RESOLVED' : park.reason === 'unresolved' ? 'ESCALATED' : 'STOPPED';
    return { currentNodeId: park.nodeKey, nextActionAt: null, state, stopReason: `graph:${park.reason}` };
  }

  /** The newest decided approval per invoice: true when approved. A newer pending one means still waiting. */
  private async latestDecisions(invoiceIds: string[]): Promise<Map<string, boolean | undefined>> {
    const decisions = new Map<string, boolean | undefined>();
    if (invoiceIds.length === 0) return decisions;
    const rows = await this.prisma.approvalRequest.findMany({
      where: { approvalType: ApprovalType.INVOICE_DUNNING, referenceId: { in: invoiceIds } },
      orderBy: { createdAt: 'desc' },
      select: { referenceId: true, status: true },
    });
    for (const row of rows) {
      if (decisions.has(row.referenceId)) continue;
      decisions.set(row.referenceId, row.status === ApprovalStatus.PENDING ? undefined : row.status === ApprovalStatus.APPROVED);
    }
    return decisions;
  }

  private async findApprover(companyId: string, params?: Readonly<Record<string, unknown>>): Promise<string | null> {
    const role = typeof params?.approverRole === 'string' ? params.approverRole : DEFAULT_APPROVER_ROLE;
    if (!(Object.values(RoleName) as string[]).includes(role)) return null;
    const user = await this.prisma.user.findFirst({
      where: { isActive: true, deletedAt: null, role: { name: role as RoleName }, shop: { companyId } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /** Best effort: the request exists and shows in their approvals either way. */
  private async notifyApprover(request: { id: string; companyId: string; assignedTo: string; requestedBy: string; documentNumber: string | null; description: string | null }) {
    try {
      await this.notifications.create(
        {
          title: `Approval required: ${request.documentNumber ?? 'invoice'}`,
          message: request.description ?? 'A workflow is waiting for your decision',
          type: AlertType.PURCHASE_ORDER_APPROVED,
          priority: NotificationPriority.HIGH,
          module: NotificationModule.APPROVAL,
          userId: request.assignedTo,
          referenceType: ApprovalType.INVOICE_DUNNING,
          referenceId: request.id,
          deepLink: `/approvals/${request.id}`,
        },
        request.requestedBy,
        request.companyId,
      );
    } catch (err) {
      this.logger.error(`Could not notify approver for ${request.id}: ${(err as Error).message}`);
    }
  }

  /** Load the live invoice facts a thread's conditions are evaluated against. */
  private async loadFacts(invoiceId: string): Promise<
    | { invoiceNumber: string; balanceDue: number; daysFromDue: number; createdById: string | null; threadFacts: ThreadFacts }
    | null
  > {
    const invoice = await this.prisma.invoiceHeader.findUnique({
      where: { id: invoiceId },
      select: { invoiceNumber: true, status: true, dueDate: true, totalValue: true, paidValue: true, createdById: true },
    });
    if (!invoice) return null;
    const balanceDue = Number(invoice.totalValue) - Number(invoice.paidValue);
    const invoicePaid = invoice.status === InvoiceStatus.PAID || balanceDue <= 0;
    const daysFromDue = invoice.dueDate ? Math.floor((Date.now() - invoice.dueDate.getTime()) / DAY_MS) : 0;
    return {
      invoiceNumber: invoice.invoiceNumber,
      createdById: invoice.createdById,
      balanceDue,
      daysFromDue,
      // customerReplied is enforced by the lifecycle handler pausing the thread;
      // ACTIVE threads reaching here have no unhandled reply.
      threadFacts: { invoicePaid, customerReplied: false, amount: balanceDue, daysOverdue: daysFromDue },
    };
  }
}
