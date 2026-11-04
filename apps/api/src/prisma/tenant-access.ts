import type { Logger } from '@nestjs/common';
import type { Counter } from 'prom-client';

type TenantCtx = { companyId: string | null; systemAccess: boolean } | undefined;

/**
 * How a Prisma query made outside any TenantContext is treated (#239).
 * - `log` (default): unchanged behaviour, RLS bypassed, but each case is reported.
 * - `strict`: no tenant and no system access, so RLS tables return no rows and
 *   reject writes. Code that needs every tenant must use runWithSystemAccess.
 */
export type TenantContextMode = 'log' | 'strict';

export function tenantContextMode(value = process.env.TENANT_CONTEXT_MODE): TenantContextMode {
  return value?.trim().toLowerCase() === 'strict' ? 'strict' : 'log';
}

export type TenantAccess = { companyId: string; systemAccess: boolean; missingContext: boolean };

/** The `app.*` settings a query runs with, given the current TenantContext. */
export function tenantAccess(ctx: TenantCtx, mode: TenantContextMode): TenantAccess {
  if (ctx) return { companyId: ctx.companyId ?? '', systemAccess: ctx.systemAccess, missingContext: false };
  return { companyId: '', systemAccess: mode !== 'strict', missingContext: true };
}

const CALL_SITES_PER_OPERATION = 5;

/**
 * Reports queries made outside a TenantContext: a counter per model and
 * operation, and a warning for the first few distinct call sites of each, so a
 * log-only rollout lists every entry point that needs an explicit context.
 */
export class MissingTenantContextReporter {
  private readonly sites = new Map<string, Set<string>>();

  constructor(
    private readonly mode: TenantContextMode,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly counter?: Pick<Counter<string>, 'inc'>,
  ) {}

  /** Call synchronously from the caller's frame, so the stack still shows the application code. */
  report(model: string, operation: string): void {
    this.counter?.inc({ model, operation, mode: this.mode });
    const key = `${model}.${operation}`;
    const seen = this.sites.get(key) ?? new Set<string>();
    if (seen.size >= CALL_SITES_PER_OPERATION) return;
    const site = callSite(new Error().stack);
    if (seen.has(site)) return;
    seen.add(site);
    this.sites.set(key, seen);
    const effect = this.mode === 'strict' ? 'ran without tenant or system access' : 'ran with RLS bypassed';
    this.logger.warn(`[tenant-context] ${key} outside a TenantContext ${effect} at ${site}`);
  }
}

/** First stack frame in application code, skipping Prisma, the tenant plumbing and node internals. */
export function callSite(stack: string | undefined): string {
  const frames = (stack ?? '').split('\n').slice(1).map((line) => line.trim());
  const app = frames.find(
    (line) =>
      line.startsWith('at ') &&
      !line.includes('node_modules') &&
      !line.includes('node:') &&
      !/[\\/]prisma[\\/](prisma\.service|tenant-access)\.(ts|js):/.test(line),
  );
  return app ? app.replace(/^at /, '') : 'unknown';
}
