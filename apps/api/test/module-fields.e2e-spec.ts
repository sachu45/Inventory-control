import type { INestApplication } from '@nestjs/common';
import { ConfigDraftService } from '../src/common/config/config-draft.service';
import { ConfigPublishService } from '../src/common/config/config-publish.service';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed, todayDateString, unwrap } from './helpers/e2e-http';
import { seedWorkflowMasterData, type WorkflowContext } from './helpers/workflow-fixture';

type Po = { id: string; remarks?: string | null; items: { lineCategory?: string | null; lineDescription?: string | null }[] };

/** Company field config changes what the purchase-order API accepts and returns (spec §9.2). */
describe('Module field config on purchase orders (e2e)', () => {
  let app: INestApplication;
  jest.setTimeout(60_000);

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    app = await createE2eApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const poBody = (ctx: WorkflowContext, extra: Record<string, unknown> = {}) => ({
    poDate: todayDateString(),
    shopId: ctx.shopId,
    supplier: 'Field Config Supplier',
    items: [{ productId: ctx.productId, orderQty: 2, rate: 10, lineCategory: 'Service' }],
    ...extra,
  });

  it('requires configured mandatory fields, hides hidden ones, and leaves other companies alone', async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const b = await seedWorkflowMasterData(app);
    const apiA = authed(app, a.token);
    const apiB = authed(app, b.token);

    // Default config: today's behaviour.
    const before = await apiA.post('/api/v1/purchase-orders').send(poBody(a));
    expect(before.status).toBe(201);
    expect(unwrap<Po>(before.body).items[0].lineCategory).toBe('Service');

    await app.get(ConfigDraftService).create({
      companyId: a.companyId,
      moduleKey: 'purchase-orders',
      config: { mandatoryFields: ['remarks'], hiddenFields: ['lineCategory'] },
      actorId: a.user.id,
    });
    await app.get(ConfigPublishService).publish({ companyId: a.companyId, expectedBaseVersion: 0, actorId: a.user.id });

    const missing = await apiA.post('/api/v1/purchase-orders').send(poBody(a));
    expect(missing.status).toBe(422);
    expect(JSON.stringify(missing.body)).toContain('MANDATORY_FIELDS_MISSING');
    await apiA.post('/api/v1/purchase-orders').send(poBody(a, { remarks: '   ' })).expect(422);

    const created = await apiA.post('/api/v1/purchase-orders').send(poBody(a, { remarks: 'Deliver to gate 2' }));
    expect(created.status).toBe(201);
    const po = unwrap<Po>(created.body);
    expect(po.remarks).toBe('Deliver to gate 2');
    expect(po.items[0]).not.toHaveProperty('lineCategory');

    // Hidden on read: detail and list, including the PO created before the config.
    const detail = unwrap<Po>((await apiA.get(`/api/v1/purchase-orders/${po.id}`).expect(200)).body);
    expect(detail.items[0]).not.toHaveProperty('lineCategory');
    const list = unwrap<Po[]>((await apiA.get('/api/v1/purchase-orders').query({ shop_id: a.shopId }).expect(200)).body);
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const row of list) for (const item of row.items ?? []) expect(item).not.toHaveProperty('lineCategory');

    // Ignored on write: the value sent was not stored.
    const stored = await TenantContext.run({ companyId: a.companyId, inRLSTx: false, systemAccess: false }, async () =>
      await app.get(PrismaService).purchaseOrderItem.findMany({ where: { poHeaderId: po.id }, select: { lineCategory: true } }),
    );
    expect(stored).toEqual([{ lineCategory: null }]);

    // Another company keeps the default config.
    const other = await apiB.post('/api/v1/purchase-orders').send(poBody(b));
    expect(other.status).toBe(201);
    expect(unwrap<Po>(other.body).items[0].lineCategory).toBe('Service');
  });
});
