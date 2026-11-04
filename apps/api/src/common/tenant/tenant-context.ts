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
   * Runs `fn`, and everything it starts asynchronously, with no context at all.
   * Tests use it to start the app the way production does, outside any tenant.
   */
  exit: <T>(fn: () => T): T => storage.exit(fn),
};
