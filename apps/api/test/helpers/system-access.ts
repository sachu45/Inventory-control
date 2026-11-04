import { TenantContext } from '../../src/common/tenant/tenant-context';

/**
 * Runs every test and hook with explicit system access (#239).
 *
 * Test code seeds and inspects rows across tenants directly through Prisma and
 * the config services. That is test setup, not an app entry point, so it gets
 * explicit system access instead of relying on the implicit no-context fallback.
 * The app itself is started outside this context (createE2eApp), so with
 * TENANT_CONTEXT_MODE=strict the suite checks that every request, guard, job and
 * timer sets its own context. A test that needs no context at all can use
 * TenantContext.exit.
 *
 * Registered via `setupFilesAfterEnv` in test/jest-e2e.json, before any test file runs.
 */
type Fn = (...args: unknown[]) => unknown;

function withSystemAccess(fn: unknown): unknown {
  // Leave done-callback style functions alone; this suite does not use them.
  if (typeof fn !== 'function' || fn.length > 0) return fn;
  return () => TenantContext.runWithSystemAccess(async () => await (fn as Fn)());
}

function wrapRegistrar<T extends Fn>(registrar: T, callbackIndex: number): T {
  const wrapped = ((...args: unknown[]) => {
    args[callbackIndex] = withSystemAccess(args[callbackIndex]);
    return registrar(...args);
  }) as T;
  for (const key of Object.keys(registrar)) {
    const member = (registrar as unknown as Record<string, unknown>)[key];
    (wrapped as unknown as Record<string, unknown>)[key] =
      key === 'only' || key === 'skip' || key === 'failing' || key === 'concurrent'
        ? wrapRegistrar(member as Fn, callbackIndex)
        : member;
  }
  return wrapped;
}

const g = globalThis as unknown as Record<string, Fn>;
g.it = wrapRegistrar(g.it, 1);
g.test = wrapRegistrar(g.test, 1);
for (const hook of ['beforeAll', 'beforeEach', 'afterAll', 'afterEach']) {
  g[hook] = wrapRegistrar(g[hook], 0);
}
