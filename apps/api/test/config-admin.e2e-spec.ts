import { randomUUID } from 'crypto';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { BillingCycle, RoleName, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request = require('supertest');
import { PlatformAdminGuard } from '../src/modules/platform/platform-admin.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed, login, unwrap } from './helpers/e2e-http';

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@retailims.com';
const PASSWORD = 'E2eConfig@123';

type Route = { method: string; path: string; guarded: boolean };

/** Every route the app serves, read from controller metadata, with its guard status. */
function routeTable(app: INestApplication): Route[] {
  const routes: Route[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
      if (!ctrl) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
      const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, ctrl) ?? [];
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = (ctrl.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        if (sub === undefined || method === undefined) continue;
        const handlerGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
        routes.push({
          method: RequestMethod[method as RequestMethod],
          path: `/${[base, String(sub)].map((p) => p.replace(/^\/|\/$/g, '')).filter(Boolean).join('/')}`,
          guarded: [...classGuards, ...handlerGuards].includes(PlatformAdminGuard),
        });
      }
    }
  }
  return routes;
}

describe('Platform config admin API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let tenantToken: string;
  let companyId: string;
  let shopId: string;
  let ownerId: string;
  const created: string[] = [];
  const previousAllowlist = process.env.PLATFORM_ADMIN_EMAILS;

  const createTenant = async (tag: string) => {
    const owner = await prisma.role.findFirstOrThrow({ where: { name: RoleName.OWNER } });
    const suffix = `${tag}-${randomUUID().slice(0, 8)}`;
    const company = await prisma.company.create({
      data: {
        companyCode: `CA-${suffix}`.toUpperCase(),
        companyName: `Config admin ${suffix}`,
        subscriptionPlan: SubscriptionPlan.PLUS,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        billingCycle: BillingCycle.YEARLY,
        subscriptionEndsAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      },
    });
    created.push(company.id);
    const shop = await prisma.shop.create({
      data: {
        companyId: company.id,
        shopNumber: `CA-${suffix}`.slice(0, 20).toUpperCase(),
        shopName: `Shop ${suffix}`,
        address: 'n/a',
        contactPerson: 'n/a',
        mobile: '0000000000',
        email: `shop-${suffix}@e2e.local`,
      },
    });
    const email = `owner-${suffix}@e2e.local`;
    const user = await prisma.user.create({
      data: {
        name: `Owner ${suffix}`,
        email,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        roleId: owner.id,
        shopId: shop.id,
        isActive: true,
      },
    });
    return { companyId: company.id, shopId: shop.id, ownerId: user.id, email };
  };

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    adminToken = (await login(app)).accessToken;

    const target = await createTenant('t');
    ({ companyId, shopId, ownerId } = target);
    // A regular tenant owner: full rights in their own company, no platform access.
    const outsider = await createTenant('o');
    tenantToken = (await login(app, outsider.email, PASSWORD)).accessToken;
  });

  afterAll(async () => {
    if (!E2E_DB_ENABLED) return;
    process.env.PLATFORM_ADMIN_EMAILS = previousAllowlist;
    await prisma.company.deleteMany({ where: { id: { in: created } } });
    await app.close();
  });

  const admin = () => authed(app, adminToken);

  it('requires platform admin on every /platform route', async () => {
    if (!E2E_DB_ENABLED) return;
    const platformRoutes = routeTable(app).filter((r) => r.path === '/platform' || r.path.startsWith('/platform/'));
    expect(platformRoutes.length).toBeGreaterThanOrEqual(15);
    expect(platformRoutes.filter((r) => !r.guarded)).toEqual([]);

    for (const route of platformRoutes) {
      const path = `/api/v1${route.path}`
        .replace(/:(companyId|shopId|userId|id)\b/g, randomUUID())
        .replace(/:[A-Za-z]+/g, '1');
      const verb = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';
      await request(app.getHttpServer())[verb](path).expect(401);
      const asTenant = await authed(app, tenantToken)[verb](path).send({});
      expect({ route: `${route.method} ${route.path}`, status: asTenant.status }).toEqual({
        route: `${route.method} ${route.path}`,
        status: 403,
      });
    }
  });

  it('runs draft -> preview -> publish -> rollback for another company', async () => {
    if (!E2E_DB_ENABLED) return;
    const base = `/api/v1/platform/tenants/${companyId}`;

    const tenants = unwrap<{ items: { id: string }[] }>((await admin().get('/api/v1/platform/tenants').query({ search: 'Config admin t-' }).expect(200)).body);
    expect(tenants.items.map((t) => t.id)).toContain(companyId);
    const tenant = unwrap<{ shops: { id: string }[]; activeConfig: unknown }>((await admin().get(base).expect(200)).body);
    expect(tenant.shops.map((s) => s.id)).toEqual([shopId]);
    expect(tenant.activeConfig).toBeNull();
    await admin().get(`/api/v1/platform/tenants/${randomUUID()}`).expect(404);
    await admin().get('/api/v1/platform/tenants/not-a-uuid').expect(400);

    // Drafts: unknown module 400, invalid 422 with every error, create, stale revision 409.
    await admin().put(`${base}/draft/modules/ghost`).send({ config: {} }).expect(400);
    const invalid = await admin()
      .put(`${base}/draft/modules/purchase-orders`)
      .send({ config: { hiddenFields: ['supplier', 'madeUp'] } })
      .expect(422);
    expect(invalid.body.error.code).toBe('CONFIG_INVALID');
    expect(invalid.body.error.details.length).toBeGreaterThanOrEqual(2);
    await admin().put(`${base}/draft/modules/contracts`).send({ config: {}, extra: 1 }).expect(400);

    const draft = unwrap<{ revision: number }>(
      (await admin().put(`${base}/draft/modules/contracts`).send({ enabled: false, config: {} }).expect(200)).body,
    );
    expect(draft.revision).toBe(1);
    const stale = await admin().put(`${base}/draft/modules/contracts`).send({ enabled: true, config: {} }).expect(409);
    expect(stale.body.error).toMatchObject({ code: 'CONFIG_DRAFT_REVISION_CONFLICT', details: { currentRevision: 1 } });
    await admin()
      .put(`${base}/draft/modules/contracts`)
      .send({ enabled: false, config: { label: 'Agreements' }, revision: 1 })
      .expect(200);
    await admin().put(`${base}/draft/shops/${shopId}/modules/rfqs`).send({ enabled: false, config: {} }).expect(200);
    const foreignShop = (await prisma.shop.findFirstOrThrow({ where: { companyId: { in: created, not: companyId } } })).id;
    await admin().put(`${base}/draft/shops/${foreignShop}/modules/rfqs`).send({ enabled: false, config: {} }).expect(422);

    const drafts = unwrap<{ modules: { key: string; draft: { revision: number } | null; shops: unknown[] }[] }>(
      (await admin().get(`${base}/draft/modules`).expect(200)).body,
    );
    expect(drafts.modules).toHaveLength(29);
    expect(drafts.modules.find((m) => m.key === 'contracts')?.draft?.revision).toBe(2);
    expect(drafts.modules.find((m) => m.key === 'rfqs')?.shops).toHaveLength(1);

    // Preview writes nothing; publish needs the right base version.
    const preview = unwrap<{ baseVersion: number; issues: unknown[]; changes: { path: string }[] }>(
      (await admin().post(`${base}/draft/preview`).expect(200)).body,
    );
    expect(preview).toMatchObject({ baseVersion: 0, issues: [] });
    expect(preview.changes.map((c) => c.path)).toEqual(
      expect.arrayContaining(["company.contracts.enabled", "company.contracts.config.label", `shops.${shopId}`]),
    );
    await admin().post(`${base}/publish`).send({ expectedBaseVersion: 1 }).expect(409);
    const v1 = unwrap<{ version: { version: number } }>(
      (await admin().post(`${base}/publish`).send({ expectedBaseVersion: 0, note: 'first' }).expect(201)).body,
    );
    expect(v1.version.version).toBe(1);

    // Effective config: provenance, shop override, and what the tenant owner may use.
    const effective = unwrap<{
      config: { version: number; modules: Record<string, { enabled: boolean }>; provenance: Record<string, string> };
      user: { usableModules: string[] };
    }>((await admin().get(`${base}/effective`).query({ shopId, userId: ownerId }).expect(200)).body);
    expect(effective.config.version).toBe(1);
    expect(effective.config.modules.rfqs.enabled).toBe(false);
    expect(effective.config.provenance).toMatchObject({ 'contracts.enabled': 'company', 'rfqs.enabled': 'shop' });
    expect(effective.user.usableModules).not.toContain('contracts');
    expect(effective.user.usableModules).toContain('purchase-orders');
    await admin().get(`${base}/effective`).query({ userId: randomUUID() }).expect(404);

    // Second version, then roll back to the first.
    await admin().put(`${base}/draft/modules/contracts`).send({ enabled: true, config: {}, revision: 2 }).expect(200);
    await admin().post(`${base}/publish`).send({ expectedBaseVersion: 1 }).expect(201);
    const diff = unwrap<{ changes: { path: string }[] }>((await admin().get(`${base}/versions/1/diff/2`).expect(200)).body);
    expect(diff.changes.map((c) => c.path)).toEqual(['company.contracts.config.label', 'company.contracts.enabled']);

    const rolledBack = unwrap<{ version: { version: number; sourceVersion: number } }>(
      (await admin().post(`${base}/versions/1/rollback`).send({ expectedBaseVersion: 2 }).expect(201)).body,
    );
    expect(rolledBack.version).toMatchObject({ version: 3, sourceVersion: 1 });
    const versions = unwrap<{ version: number }[]>((await admin().get(`${base}/versions`).expect(200)).body);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    const v3 = unwrap<{ snapshot: { company: Record<string, { enabled: boolean }> } }>(
      (await admin().get(`${base}/versions/3`).expect(200)).body,
    );
    expect(v3.snapshot.company.contracts.enabled).toBe(false);
    await admin().get(`${base}/versions/9`).expect(404);

    // Reset needs the current revision; rollback recreated the drafts at revision 1.
    await admin().delete(`${base}/draft/modules/contracts`).expect(409);
    expect(unwrap((await admin().delete(`${base}/draft/modules/contracts`).query({ revision: 1 }).expect(200)).body)).toEqual({ reset: true });
    expect(unwrap((await admin().delete(`${base}/draft/modules/contracts`).expect(200)).body)).toEqual({ reset: false });
    await admin().delete(`${base}/draft/shops/${shopId}/modules/rfqs`).query({ revision: 1 }).expect(200);

    // Every mutation is in the tenant's config audit trail, with the request IP.
    const audit = unwrap<{ items: { newValues: { platformAction?: string } | null; ipAddress: string | null; companyId?: string }[] }>(
      (await admin().get(`${base}/audit`).query({ type: 'config', take: 100 }).expect(200)).body,
    );
    const actions = audit.items.map((a) => a.newValues?.platformAction).filter(Boolean);
    expect(actions).toEqual(
      expect.arrayContaining([
        'platform_config_draft_set',
        'platform_config_draft_reset',
        'platform_config_publish',
        'platform_config_rollback',
      ]),
    );
    expect(audit.items.filter((a) => a.newValues?.platformAction).every((a) => a.ipAddress)).toBe(true);
    await admin().get(`${base}/audit`).query({ type: 'users' }).expect(400);
  });
});
