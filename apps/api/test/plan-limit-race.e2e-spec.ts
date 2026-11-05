import type { INestApplication } from '@nestjs/common';
import { RoleName, SubscriptionPlan } from '@prisma/client';
import { PLAN_LIMITS } from '../src/common/plans/plan-config';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed } from './helpers/e2e-http';
import { seedWorkflowMasterData } from './helpers/workflow-fixture';

/** Plan limits hold under concurrent creates: the check and the create share a locked transaction. */
describe('Plan limits under concurrent creates (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  jest.setTimeout(90_000);

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    app = await createE2eApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const proCompany = async () => {
    const ctx = await seedWorkflowMasterData(app);
    await TenantContext.runWithSystemAccess(() =>
      prisma.company.update({ where: { id: ctx.companyId }, data: { subscriptionPlan: SubscriptionPlan.PRO } }),
    );
    return ctx;
  };

  it('creates exactly up to the warehouse limit when shops are created at once', async () => {
    if (!E2E_DB_ENABLED) return;
    const ctx = await proCompany();
    const max = PLAN_LIMITS.PRO.maxWarehouses;
    const tag = Date.now().toString(36).toUpperCase();
    const responses = await Promise.all(
      Array.from({ length: max + 3 }, (_, i) =>
        authed(app, ctx.token)
          .post('/api/v1/shops')
          .send({
            shopNumber: `R${tag}${i}`.slice(0, 20),
            shopName: `Race ${tag} ${i}`,
            address: 'n/a',
            contactPerson: 'n/a',
            mobile: '9000000000',
            email: `race-${tag}-${i}@e2e.local`.toLowerCase(),
          }),
      ),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(max - 1); // the fixture already has one shop
    expect(statuses.filter((s) => s !== 201).every((s) => s === 403)).toBe(true);
    const shops = await TenantContext.runWithSystemAccess(() => prisma.shop.count({ where: { companyId: ctx.companyId } }));
    expect(shops).toBe(max);
  });

  it('creates exactly up to the user limit when users are created at once', async () => {
    if (!E2E_DB_ENABLED) return;
    const ctx = await proCompany();
    const max = PLAN_LIMITS.PRO.maxUsers;
    const role = await TenantContext.runWithSystemAccess(() =>
      prisma.role.findFirstOrThrow({ where: { name: RoleName.EMPLOYEE } }),
    );
    const existing = await TenantContext.runWithSystemAccess(() =>
      prisma.user.count({ where: { shop: { companyId: ctx.companyId }, deletedAt: null } }),
    );
    const tag = Date.now().toString(36);
    const responses = await Promise.all(
      Array.from({ length: max - existing + 4 }, (_, i) =>
        authed(app, ctx.token)
          .post('/api/v1/users')
          .send({ name: `Race ${i}`, email: `race-${tag}-${i}@e2e.local`, password: 'Race@12345678', roleId: role.id, shopId: ctx.shopId }),
      ),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(max - existing);
    expect(statuses.filter((s) => s !== 201).every((s) => s === 403)).toBe(true);
    const users = await TenantContext.runWithSystemAccess(() =>
      prisma.user.count({ where: { shop: { companyId: ctx.companyId }, deletedAt: null } }),
    );
    expect(users).toBe(max);
  });
});
