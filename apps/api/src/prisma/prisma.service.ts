import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { RequestContextStore } from '../common/context/request-context';
import { TenantContext } from '../common/tenant/tenant-context';
import { MetricsService } from '../common/observability/metrics.service';
import { createPgAdapter } from './pg-adapter';
import { MissingTenantContextReporter, tenantAccess, tenantContextMode } from './tenant-access';

/**
 * Models that maintain a `deletedAt` timestamp instead of being hard-deleted.
 * Reads are NOT auto-filtered: callers filter `deletedAt: null` explicitly
 * (supplier duplicate detection and code numbering need to see archived rows).
 */
type SoftDeleteModelLower = 'user' | 'supplier';

/** Own members of PrismaService (and its instance state) that must not be routed to the extended client. */
const SERVICE_MEMBERS = new Set<PropertyKey>(['logger', 'softDelete', 'onModuleInit', 'onModuleDestroy']);

/** Set tenant or explicit system access for the current transaction. */
function setTenantConfig(
  client: Pick<PrismaClient, '$executeRaw'>,
  companyId: string,
  systemAccess: boolean,
) {
  return client.$executeRaw`
    SELECT
      set_config('app.current_company_id', ${companyId}, true),
      set_config('app.allow_unscoped_access', ${systemAccess ? 'true' : 'false'}, true)
  `;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Optional() metrics?: MetricsService) {
    super({
      adapter: createPgAdapter(),
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });

    const slowMs = Number(process.env.SLOW_QUERY_MS ?? '200');
    // Tap query events at warn level when they exceed the slow-query budget.
    // Params are intentionally omitted to keep PII out of structured logs.
    (
      this as unknown as { $on: (event: 'query', cb: (e: Prisma.QueryEvent) => void) => void }
    ).$on('query', (event) => {
      if (event.duration >= slowMs) {
        const ctx = RequestContextStore.get();
        const requestId = ctx?.requestId ?? null;
        this.logger.warn(
          `[slow-query] ${event.duration}ms ${requestId ? `req=${requestId} ` : ''}${event.query.replace(/\s+/g, ' ').slice(0, 240)}`,
        );
      }
    });

    // Build a tenant-aware extended client and proxy model access on `this` to
    // it so existing `prisma.shop.findMany(...)` calls run with the RLS company
    // context. The extension itself uses the base client to avoid recursion.
    const base = this as unknown as PrismaClient;
    const mode = tenantContextMode();
    const reporter = new MissingTenantContextReporter(mode, this.logger, metrics?.prismaMissingTenantContext);

    const extended = base.$extends({
      query: {
        $allModels: {
          async $allOperations({ args, query }) {
            const ctx = TenantContext.get();
            if (ctx?.inRLSTx) {
              return query(args);
            }

            // Missing contexts are reported where the model method is called (see the
            // proxy below): by the time Prisma runs this, the caller's stack is gone.
            const { companyId, systemAccess } = tenantAccess(ctx, mode);
            const inner = { companyId: ctx?.companyId ?? null, inRLSTx: true, systemAccess };
            const scopedQuery = TenantContext.run(inner, () => query(args));
            const [, result] = await base.$transaction([
              setTenantConfig(base, companyId, systemAccess),
              scopedQuery,
            ]);
            return result;
          },
        },
      },
    });

    // Interactive and batch transactions set the tenant on their own connection
    // up front and mark the context so the per-query wrapper above does not open
    // a second transaction (and a second pooled connection) for each query.
    const extendedTransaction = (extended.$transaction as (...a: unknown[]) => Promise<unknown>).bind(
      extended,
    );
    const tenantTransaction = (arg: unknown, options?: unknown): Promise<unknown> => {
      const ctx = TenantContext.get();
      if (ctx?.inRLSTx) {
        return extendedTransaction(arg, options);
      }
      const { companyId, systemAccess, missingContext } = tenantAccess(ctx, mode);
      if (missingContext) reporter.report('$transaction', typeof arg === 'function' ? 'interactive' : 'batch');
      const inner = { companyId: ctx?.companyId ?? null, inRLSTx: true, systemAccess };
      if (typeof arg === 'function') {
        return extendedTransaction(async (tx: PrismaClient) => {
          await setTenantConfig(tx, companyId, systemAccess);
          return TenantContext.run(inner, () => (arg as (t: PrismaClient) => unknown)(tx));
        }, options);
      }
      return TenantContext.run(inner, () =>
        extendedTransaction([setTenantConfig(base, companyId, systemAccess), ...(arg as unknown[])], options),
      ).then((results) => (results as unknown[]).slice(1));
    };

    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop === '$transaction') {
          return tenantTransaction;
        }
        // PrismaService's own members, and anything the extended client lacks
        // (e.g. `$on`), come from the base instance. Model delegates must NOT:
        // PrismaClient defines them on the instance too, so a plain
        // `Reflect.has(target, prop)` check would silently bypass the extension.
        if (SERVICE_MEMBERS.has(prop) || !Reflect.has(extended as object, prop)) {
          return Reflect.get(target, prop, receiver);
        }
        const value = Reflect.get(extended as object, prop);
        if (typeof value === 'function') {
          return (value as (...a: unknown[]) => unknown).bind(extended);
        }
        // A model delegate used outside any TenantContext: report each call from
        // the caller's own frame. Inside a context the delegate is returned as is.
        if (typeof prop === 'string' && !prop.startsWith('$') && isObject(value) && !TenantContext.get()) {
          return reportingDelegate(prop, value, reporter);
        }
        return value;
      },
    });
  }

  /** Soft-delete a row by writing `deletedAt = now()`. */
  async softDelete(model: SoftDeleteModelLower, where: { id: string }): Promise<void> {
    const delegate = (this as unknown as Record<string, unknown>)[model] as {
      update: (args: { where: { id: string }; data: { deletedAt: Date } }) => Promise<unknown>;
    };
    await delegate.update({ where, data: { deletedAt: new Date() } });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** Wraps a model delegate so each method call made without a TenantContext is reported. */
function reportingDelegate(model: string, delegate: object, reporter: MissingTenantContextReporter): object {
  return new Proxy(delegate, {
    get: (target, operation, receiver) => {
      const member = Reflect.get(target, operation, receiver) as unknown;
      if (typeof member !== 'function' || typeof operation !== 'string') return member;
      return (...args: unknown[]) => {
        if (!TenantContext.get()) reporter.report(model, operation);
        return (member as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
