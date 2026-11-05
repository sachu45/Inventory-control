import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { PrismaService } from '@/prisma/prisma.service';
import { REDIS_CLIENT } from '@/common/cache/redis.provider';

/**
 * Per-tenant feature flags (Plan §10 "Feature Flags"). A flag resolves as:
 *
 *   per-company override (notification_policies scope='feature-flag')
 *     ↳ falls back to the global env default (WORKFLOW_FLAG_<NAME>=true)
 *       ↳ falls back to the built-in default below.
 *
 * This lets AI / Simulation / Workflow Builder / Optimizer be dark-launched and
 * enabled tenant-by-tenant without a deploy. Backed by the existing
 * NotificationPolicy table (scope='feature-flag') to avoid new schema; a partial
 * unique index keeps one row per (company, flag).
 */
export const WORKFLOW_FEATURES = [
  'ai-advisor',
  'simulation',
  'workflow-builder',
  'optimizer',
  'predictive-ai',
  'channel-routing',
  // Hands a tenant's dunning from the ladder sweep over to the workflow graph.
  'graph-execution',
] as const;

export type WorkflowFeature = (typeof WORKFLOW_FEATURES)[number];

/** `notification_policies.scope` of flag rows. Reserved: the policy API can't read or write it. */
export const FEATURE_FLAG_SCOPE = 'feature-flag';

const BUILTIN_DEFAULTS: Record<WorkflowFeature, boolean> = {
  'ai-advisor': false,
  simulation: true,
  'workflow-builder': false,
  optimizer: false,
  'predictive-ai': false,
  'channel-routing': false,
  'graph-execution': false,
};

/**
 * Flags a tenant OWNER/ADMIN may switch for their own company. Every other flag
 * is dark-launched and only a platform admin sets it, so rollout stays tenant
 * by tenant under our control.
 */
export const TENANT_WRITABLE_FEATURES: ReadonlySet<WorkflowFeature> = new Set<WorkflowFeature>([
  'simulation',
  'channel-routing',
]);

export function isWorkflowFeature(value: unknown): value is WorkflowFeature {
  return typeof value === 'string' && (WORKFLOW_FEATURES as readonly string[]).includes(value);
}

export type FeatureFlagSource = 'override' | 'env' | 'default';

export interface FeatureFlagState {
  feature: WorkflowFeature;
  enabled: boolean;
  source: FeatureFlagSource;
  tenantWritable: boolean;
}

@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);
  /** Redis L2 cache TTL (ms). Shared across instances; invalidated on write. */
  private static readonly TTL_MS = 30_000;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private key(companyId: string, feature: WorkflowFeature): string {
    return `wf:flag:${companyId}:${feature}`;
  }

  async isEnabled(companyId: string, feature: WorkflowFeature): Promise<boolean> {
    const cacheKey = this.key(companyId, feature);
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) return cached === '1';
    } catch (err) {
      this.logger.warn(`flag cache read failed (${(err as Error).message}); reading source`);
    }

    const override = await this.prisma.notificationPolicy.findFirst({
      where: { companyId, scope: FEATURE_FLAG_SCOPE, name: feature },
    });
    const value = override ? this.readEnabled(override.action) : this.globalDefault(feature);
    await this.cacheSet(cacheKey, value);
    return value;
  }

  /**
   * Which companies have `feature` on, as a Prisma companyId filter: an
   * allow-list when the global default is off, a deny-list when it is on.
   */
  async companyFilter(feature: WorkflowFeature): Promise<{ in: string[] } | { notIn: string[] }> {
    const overrides = await this.prisma.notificationPolicy.findMany({
      where: { scope: FEATURE_FLAG_SCOPE, name: feature },
      select: { companyId: true, action: true },
    });
    const defaultOn = this.globalDefault(feature);
    const ids = overrides
      .filter((o) => this.readEnabled(o.action) !== defaultOn)
      .map((o) => o.companyId);
    return defaultOn ? { notIn: ids } : { in: ids };
  }

  /** Every known flag for a company, with where its value comes from. Reads Postgres, not the cache. */
  async list(companyId: string): Promise<FeatureFlagState[]> {
    const overrides = await this.prisma.notificationPolicy.findMany({
      where: { companyId, scope: FEATURE_FLAG_SCOPE, name: { in: [...WORKFLOW_FEATURES] } },
      select: { name: true, action: true },
    });
    const byName = new Map(overrides.map((o) => [o.name, o.action]));
    return WORKFLOW_FEATURES.map((feature) => {
      const tenantWritable = TENANT_WRITABLE_FEATURES.has(feature);
      if (byName.has(feature)) {
        return { feature, enabled: this.readEnabled(byName.get(feature)), source: 'override' as const, tenantWritable };
      }
      const env = this.envDefault(feature);
      return env === undefined
        ? { feature, enabled: BUILTIN_DEFAULTS[feature], source: 'default' as const, tenantWritable }
        : { feature, enabled: env, source: 'env' as const, tenantWritable };
    });
  }

  /**
   * Set a per-company override and invalidate the shared cache. One row per
   * (company, flag): the insert-or-update is a single statement on the partial
   * unique index, so concurrent writes can't store duplicates. Returns the
   * previous override (null when there was none), for audit.
   */
  async setEnabled(
    companyId: string,
    feature: WorkflowFeature,
    enabled: boolean,
  ): Promise<{ feature: WorkflowFeature; enabled: boolean; previous: boolean | null }> {
    const previous = await this.prisma.notificationPolicy.findFirst({
      where: { companyId, scope: FEATURE_FLAG_SCOPE, name: feature },
      select: { action: true },
    });
    const action = JSON.stringify({ enabled });
    // The interactive transaction sets the tenant (RLS) config on its connection.
    await this.prisma.$transaction((tx) =>
      tx.$executeRaw(Prisma.sql`
        INSERT INTO notification_policies (id, company_id, name, scope, enabled, priority, condition, action, updated_at)
        VALUES (gen_random_uuid(), ${companyId}::uuid, ${feature}, ${FEATURE_FLAG_SCOPE}, true, 0, '{}'::jsonb, ${action}::jsonb, now())
        ON CONFLICT (company_id, name) WHERE scope = 'feature-flag'
        DO UPDATE SET action = EXCLUDED.action, updated_at = now()`),
    );
    try {
      await this.redis.del(this.key(companyId, feature));
    } catch (err) {
      this.logger.warn(`flag cache invalidation failed (${(err as Error).message})`);
    }
    return { feature, enabled, previous: previous ? this.readEnabled(previous.action) : null };
  }

  private async cacheSet(key: string, value: boolean): Promise<void> {
    try {
      await this.redis.set(key, value ? '1' : '0', 'PX', FeatureFlagsService.TTL_MS);
    } catch {
      // Cache write is best-effort; the source of truth is Postgres/env.
    }
  }

  private globalDefault(feature: WorkflowFeature): boolean {
    return this.envDefault(feature) ?? BUILTIN_DEFAULTS[feature];
  }

  private envDefault(feature: WorkflowFeature): boolean | undefined {
    const env = this.config.get<string>(`WORKFLOW_FLAG_${feature.toUpperCase().replace(/-/g, '_')}`);
    if (env === 'true') return true;
    if (env === 'false') return false;
    return undefined;
  }

  private readEnabled(action: unknown): boolean {
    return typeof action === 'object' && action !== null && (action as { enabled?: unknown }).enabled === true;
  }
}
