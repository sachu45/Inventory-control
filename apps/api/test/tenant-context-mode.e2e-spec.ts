import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { E2E_DB_ENABLED } from './helpers/e2e-bootstrap';

/** A Prisma query outside any TenantContext: RLS bypassed in log mode, no access in strict mode (#239). */
describe('TENANT_CONTEXT_MODE (e2e)', () => {
  const saved = process.env.TENANT_CONTEXT_MODE;
  const clients: PrismaService[] = [];

  const client = async (mode: string | undefined) => {
    if (mode === undefined) delete process.env.TENANT_CONTEXT_MODE;
    else process.env.TENANT_CONTEXT_MODE = mode;
    const prisma = new PrismaService();
    await prisma.$connect();
    clients.push(prisma);
    return prisma;
  };

  // Test code runs with system access (helpers/system-access.ts); these checks need no context at all.
  // Awaited inside exit: Prisma queries are lazy and run in the context they are awaited in.
  const none = <T>(fn: () => Promise<T>): Promise<T> => TenantContext.exit(async () => await fn());

  afterAll(async () => {
    if (saved === undefined) delete process.env.TENANT_CONTEXT_MODE;
    else process.env.TENANT_CONTEXT_MODE = saved;
    await Promise.all(clients.map((c) => c.$disconnect()));
  });

  it('log mode (default) keeps today\'s behaviour: no context sees every tenant', async () => {
    if (!E2E_DB_ENABLED) return;
    const prisma = await client(undefined);
    const all = await TenantContext.runWithSystemAccess(() => prisma.company.count());
    expect(all).toBeGreaterThan(0);
    expect(await none(() => prisma.company.count())).toBe(all);
    expect(await none(() => prisma.$transaction([prisma.company.count()]))).toEqual([all]);
  });

  it('strict mode: no context sees no tenant rows and cannot write them; explicit system access still works', async () => {
    if (!E2E_DB_ENABLED) return;
    const prisma = await client('strict');
    const all = await TenantContext.runWithSystemAccess(() => prisma.company.count());
    expect(all).toBeGreaterThan(0);

    expect(await none(() => prisma.company.count())).toBe(0);
    expect(await none(() => prisma.$transaction([prisma.company.count()]))).toEqual([0]);
    expect(await none(() => prisma.$transaction(async (tx) => tx.company.count()))).toBe(0);
    await expect(
      none(() => prisma.company.create({ data: { companyCode: `STRICT-${Date.now()}`, companyName: 'strict probe' } })),
    ).rejects.toThrow(/row-level security/);

    // A tenant context still sees its own company.
    const one = await TenantContext.runWithSystemAccess(() => prisma.company.findFirstOrThrow({ select: { id: true } }));
    const own = await TenantContext.run({ companyId: one.id, inRLSTx: false, systemAccess: false }, async () =>
      await prisma.company.findMany({ select: { id: true } }),
    );
    expect(own).toEqual([{ id: one.id }]);
  });
});
