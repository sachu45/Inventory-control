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

/**
 * True when Prisma says this query is not part of any transaction. Prisma puts
 * the transaction on the (internal) params of queries made through a
 * transaction client; when it doesn't expose params at all, assume the query
 * belongs to the open transaction, as before.
 */
function isOutsideTransaction(params: unknown): boolean {
  const internal = (params as { __internalParams?: { transaction?: unknown } }).__internalParams;
  return internal !== undefined && internal.transaction === undefined;
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
          async $allOperations(params) {
            const { args, query } = params;
            const ctx = TenantContext.get();
            // Inside a tenant transaction its connection already has the RLS config,
            // so queries made through the transaction client skip setting it. A query
            // made through the base client while that transaction is open (a service
            // called from the callback, such as an audit write) runs on another pooled
            // connection with no tenant, so it sets the config like any other query.
            if (ctx?.inRLSTx && !isOutsideTransaction(params)) {
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
      // Always a new transaction on its own connection, even when called while another
      // is open (a service using this client from inside a callback): Prisma can't nest
      // interactive transactions, so this one must set the tenant itself.
      const ctx = TenantContext.get();
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

    // Raw SQL has no model for the extension above to wrap, so without this it would run
    // with no tenant settings: RLS tables return no rows and reject writes.
    const tenantRaw = (method: RawMethod) => (...args: unknown[]) => {
      if (!TenantContext.get()) reporter.report('$raw', method);
      const raw = (base[method] as (...a: unknown[]) => Prisma.PrismaPromise<unknown>)(...args);
      return scopedRawPromise(raw, () => {
        const { companyId, systemAccess } = tenantAccess(TenantContext.get(), mode);
        return base.$transaction([setTenantConfig(base, companyId, systemAccess), raw]).then(([, result]) => result);
      });
    };

    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop === '$transaction') {
          return tenantTransaction;
        }
        // Reached only through this service. Inside an interactive transaction callers
        // use the `tx` client, which already has the tenant set on its connection.
        if (isRawMethod(prop)) {
          return tenantRaw(prop);
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

const RAW_METHODS = ['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'] as const;
type RawMethod = (typeof RAW_METHODS)[number];

function isRawMethod(prop: PropertyKey): prop is RawMethod {
  return (RAW_METHODS as readonly PropertyKey[]).includes(prop);
}

/**
 * The raw statement's PrismaPromise, except that awaiting it runs `execute` (once, in the
 * awaiter's context, like every lazy Prisma query). Prisma's own members stay untouched,
 * so it still works in a batch `$transaction([...])`, which sets the tenant itself.
 */
function scopedRawPromise<T>(raw: Prisma.PrismaPromise<T>, execute: () => Promise<T>): Prisma.PrismaPromise<T> {
  let execution: Promise<T> | undefined;
  const run = () => (execution ??= execute());
  return new Proxy(raw, {
    get: (target, prop) => {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        const started = run() as unknown as Record<PropertyKey, (...a: unknown[]) => unknown>;
        return started[prop].bind(started);
      }
      const member = Reflect.get(target, prop) as unknown;
      return typeof member === 'function' ? (member as (...a: unknown[]) => unknown).bind(target) : member;
    },
  });
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
