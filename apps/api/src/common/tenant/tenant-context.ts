import { AsyncLocalStorage } from 'async_hooks';

interface TenantCtx {
  companyId: string | null;
  inRLSTx: boolean;
  systemAccess: boolean;
}

const storage = new AsyncLocalStorage<TenantCtx>();

export const TenantContext = {
  get: (): TenantCtx | undefined => storage.getStore(),
  run: <T>(ctx: TenantCtx, fn: () => T): T => storage.run(ctx, fn),
  /**
   * Runs platform-wide work (across every tenant) with RLS bypassed. `fn` is awaited
   * inside the context because Prisma queries are lazy and run in the context they
   * are awaited in.
   */
  runWithSystemAccess: <T>(fn: () => Promise<T>): Promise<T> =>
    storage.run({ companyId: null, inRLSTx: false, systemAccess: true }, async () => await fn()),
  /**
   * Runs `fn` with the current tenant scope but outside the current transaction.
   * For writes that deliberately use the base client while a transaction is open
   * (audit rows): inside `$transaction`, queries skip setting the RLS config
   * because the transaction's connection already has it, so a base-client query
   * there would land on a pooled connection with no tenant at all.
   */
  detached: <T>(fn: () => Promise<T>): Promise<T> => {
    const ctx = storage.getStore();
    if (!ctx?.inRLSTx) return fn();
    return storage.run({ ...ctx, inRLSTx: false }, async () => await fn());
  },
  /**
   * Runs `fn`, and everything it starts asynchronously, with no context at all.
   * Tests use it to start the app the way production does, outside any tenant.
   */
  exit: <T>(fn: () => T): T => storage.exit(fn),
};
