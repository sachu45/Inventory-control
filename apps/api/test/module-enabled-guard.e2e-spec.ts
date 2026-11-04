import { randomUUID } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { SalesQuotationStatus } from '@prisma/client';
import request = require('supertest');
import { ConfigDraftService } from '../src/common/config/config-draft.service';
import { ConfigPublishService } from '../src/common/config/config-publish.service';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed } from './helpers/e2e-http';
import { seedWorkflowMasterData, type WorkflowContext } from './helpers/workflow-fixture';

/** Disabling a module in a company's published config makes its API refuse with 403 MODULE_DISABLED. */
describe('ModuleEnabledGuard (e2e)', () => {
  let app: INestApplication;
  jest.setTimeout(60_000);

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    app = await createE2eApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('refuses a disabled module, and only for that company', async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const b = await seedWorkflowMasterData(app);
    const apiA = authed(app, a.token);
    const apiB = authed(app, b.token);

    // No published config: today's behaviour.
    await apiA.get('/api/v1/contracts').expect(200);

    await app.get(ConfigDraftService).create({
      companyId: a.companyId,
      moduleKey: 'contracts',
      enabled: false,
      actorId: a.user.id,
    });
    await app.get(ConfigPublishService).publish({ companyId: a.companyId, expectedBaseVersion: 0, actorId: a.user.id });

    const refused = await apiA.get('/api/v1/contracts');
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('MODULE_DISABLED');
    // Writes are refused before body validation runs.
    await apiA.post('/api/v1/contracts').send({}).expect(403);

    // Other modules, including the one contracts depend on, and routes without
    // @RequiresModule are unaffected.
    await apiA.get('/api/v1/suppliers').expect(200);
    await apiA.get('/api/v1/purchase-orders').expect(200);
    await apiA.get('/api/v1/auth/me').expect((res) => expect(res.status).not.toBe(403));

    // Another company keeps its own (default) config.
    await apiB.get('/api/v1/contracts').expect(200);
  });

  /** A SENT quotation with a portal link, created directly so the test doesn't depend on the send flow. */
  async function sentQuotation(ctx: WorkflowContext): Promise<string> {
    const portalToken = randomUUID();
    await TenantContext.run({ companyId: ctx.companyId, inRLSTx: false, systemAccess: false }, async () => {
      await app.get(PrismaService).salesQuotationHeader.create({
        data: {
          quoteNumber: `SQ-${portalToken.slice(0, 8)}`,
          quoteDate: new Date(),
          customerId: ctx.customerId,
          shopId: ctx.shopId,
          status: SalesQuotationStatus.SENT,
          portalToken,
          totalValue: 20,
          items: { create: [{ productId: ctx.productId, quantity: 1, uom: 'PCS', unitPrice: 20, lineValue: 20 }] },
        },
      });
    });
    return portalToken;
  }

  it('refuses the public quotation portal using the company the token belongs to', async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const b = await seedWorkflowMasterData(app);
    const tokenA = await sentQuotation(a);
    const tokenB = await sentQuotation(b);
    const portal = () => request(app.getHttpServer());

    await portal().get(`/api/v1/quotation-portal/quotes/${tokenA}`).expect(200);

    await app.get(ConfigDraftService).create({
      companyId: a.companyId,
      moduleKey: 'sales-quotations',
      enabled: false,
      actorId: a.user.id,
    });
    await app.get(ConfigPublishService).publish({ companyId: a.companyId, expectedBaseVersion: 0, actorId: a.user.id });

    const refused = await portal().get(`/api/v1/quotation-portal/quotes/${tokenA}`);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('MODULE_DISABLED');
    await portal().post(`/api/v1/quotation-portal/quotes/${tokenA}/accept`).expect(403);

    // Another company's link still works.
    await portal().get(`/api/v1/quotation-portal/quotes/${tokenB}`).expect(200);
  });
});
