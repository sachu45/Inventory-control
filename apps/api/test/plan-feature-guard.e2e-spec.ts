import type { INestApplication } from '@nestjs/common';
import { SubscriptionPlan } from '@prisma/client';
import { SubscriptionService } from '../src/modules/billing/subscription.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed, todayDateString, unwrap } from './helpers/e2e-http';
import { seedWorkflowMasterData, type WorkflowContext } from './helpers/workflow-fixture';

/** Writes to a plan-gated module need a plan that includes it; reads stay open after a downgrade (#240). */
describe('PlanFeatureGuard (e2e)', () => {
  let app: INestApplication;
  jest.setTimeout(60_000);

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    app = await createE2eApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const createPo = async (ctx: WorkflowContext) => {
    const res = await authed(app, ctx.token)
      .post('/api/v1/purchase-orders')
      .send({
        poDate: todayDateString(),
        shopId: ctx.shopId,
        supplier: 'Plan Gate Supplier',
        items: [{ productId: ctx.productId, orderQty: 1, rate: 5 }],
      });
    expect(res.status).toBe(201);
    return unwrap<{ id: string }>(res.body).id;
  };

  it('a company downgraded to TRIAL keeps reading its purchase orders but cannot change them', async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const b = await seedWorkflowMasterData(app);
    const poA = await createPo(a);
    const poB = await createPo(b);

    // Downgrade A to an active trial (not expired, so the read-only guard stays out of the way).
    await app.get(PrismaService).company.update({
      where: { id: a.companyId },
      data: {
        subscriptionPlan: SubscriptionPlan.TRIAL,
        trialStartsAt: new Date(),
        trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    app.get(SubscriptionService).clearWriteBlockCache(a.companyId);

    const apiA = authed(app, a.token);
    await apiA.get(`/api/v1/purchase-orders/${poA}`).expect(200);
    await apiA.get('/api/v1/purchase-orders').query({ shop_id: a.shopId }).expect(200);

    const refused = await apiA.post(`/api/v1/purchase-orders/${poA}/confirm`);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('PLAN_FEATURE_REQUIRED');
    await apiA.patch(`/api/v1/purchase-orders/${poA}`).send({ remarks: 'x' }).expect(403);

    // Modules without a plan gate are unaffected.
    await apiA
      .post('/api/v1/suppliers')
      .send({ supplierCode: `PG-${Date.now()}`.slice(0, 30), supplierName: 'Still allowed' })
      .expect(201);

    // The other company keeps its plan.
    await authed(app, b.token).post(`/api/v1/purchase-orders/${poB}/confirm`).expect(201);
  });
});
