import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { BillingCycle, RoleName, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request = require('supertest');
import { resolveRolePermissions } from '../src/common/auth/role-permissions';
import { ConfigDraftService } from '../src/common/config/config-draft.service';
import { ConfigPublishService } from '../src/common/config/config-publish.service';
import { MODULE_KEYS, MODULE_REGISTRY, deriveSidebar } from '../src/common/config/module-registry';
import type { MeConfigResponse } from '../src/modules/me-config/me-config.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed, login, unwrap } from './helpers/e2e-http';

const PASSWORD = 'E2eMeConfig@123';

type Tenant = { companyId: string; shopId: string; ownerEmail: string; ownerId: string };

describe('GET /me/config and PUT /me/preferences (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Tenant;
  let b: Tenant;
  let viewerEmail: string;
  let viewerPermissions: Set<string>;
  const created: string[] = [];
  const tokens = new Map<string, string>();

  const createUser = async (shopId: string, role: RoleName, tag: string) => {
    const roleRow = await prisma.role.findFirstOrThrow({ where: { name: role } });
    const email = `${role.toLowerCase()}-${tag}@e2e.local`;
    const user = await prisma.user.create({
      data: { name: `${role} ${tag}`, email, passwordHash: await bcrypt.hash(PASSWORD, 4), roleId: roleRow.id, shopId },
    });
    return { email, id: user.id };
  };

  const createTenant = async (plan: SubscriptionPlan): Promise<Tenant> => {
    const tag = randomUUID().slice(0, 8);
    const company = await prisma.company.create({
      data: {
        companyCode: `ME-${tag}`.toUpperCase(),
        companyName: `Me config ${tag}`,
        subscriptionPlan: plan,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        billingCycle: plan === SubscriptionPlan.TRIAL ? null : BillingCycle.YEARLY,
        trialEndsAt: plan === SubscriptionPlan.TRIAL ? new Date(Date.now() + 5 * 24 * 3600 * 1000) : null,
        subscriptionEndsAt: plan === SubscriptionPlan.TRIAL ? null : new Date(Date.now() + 300 * 24 * 3600 * 1000),
      },
    });
    created.push(company.id);
    const shop = await prisma.shop.create({
      data: {
        companyId: company.id,
        shopNumber: `ME-${tag}`.toUpperCase(),
        shopName: `Me shop ${tag}`,
        address: 'n/a',
        contactPerson: 'n/a',
        mobile: '0000000000',
        email: `me-shop-${tag}@e2e.local`,
      },
    });
    const owner = await createUser(shop.id, RoleName.OWNER, tag);
    return { companyId: company.id, shopId: shop.id, ownerEmail: owner.email, ownerId: owner.id };
  };

  const token = async (email: string) => {
    if (!tokens.has(email)) tokens.set(email, (await login(app, email, PASSWORD)).accessToken);
    return tokens.get(email)!;
  };
  const getConfig = async (email: string) => {
    const res = await authed(app, await token(email)).get('/api/v1/me/config').expect(200);
    return { body: unwrap<MeConfigResponse>(res.body), etag: res.headers.etag as string };
  };
  const sidebarPaths = (body: MeConfigResponse) => body.sidebar.map((s) => [s.id, s.children.map((c) => c.path)]);

  /** Today's web sidebar for a user: SIDEBAR_SECTIONS filtered by the web app's visibility rule. */
  const expectedSidebar = (isOrgAdmin: boolean, permissions: Set<string>) =>
    deriveSidebar()
      .map((s) => ({
        ...s,
        children: s.children.filter(
          (link) =>
            (!link.requireOrgAdmin || isOrgAdmin) &&
            (!link.permission || isOrgAdmin || permissions.has(link.permission)),
        ),
      }))
      .filter((s) => s.children.length > 0)
      .map((s) => [s.id, s.children.map((c) => c.path)]);

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    app = await createE2eApp();
    prisma = app.get(PrismaService);

    a = await createTenant(SubscriptionPlan.PLUS);
    const viewer = await createUser(a.shopId, RoleName.VIEWER, randomUUID().slice(0, 8));
    viewerEmail = viewer.email;
    const viewerRole = await prisma.role.findFirstOrThrow({ where: { name: RoleName.VIEWER } });
    viewerPermissions = new Set(await resolveRolePermissions(prisma, a.companyId, viewerRole));

    // B (TRIAL) has a published config: contracts off, invoices renamed, PO remarks mandatory.
    b = await createTenant(SubscriptionPlan.TRIAL);
    const drafts = app.get(ConfigDraftService);
    await drafts.create({ companyId: b.companyId, moduleKey: 'contracts', enabled: false, actorId: b.ownerId });
    await drafts.create({ companyId: b.companyId, moduleKey: 'invoices', config: { label: 'Billing Desk' }, actorId: b.ownerId });
    await drafts.create({
      companyId: b.companyId,
      moduleKey: 'purchase-orders',
      config: { mandatoryFields: ['remarks'] },
      actorId: b.ownerId,
    });
    await app.get(ConfigPublishService).publish({ companyId: b.companyId, expectedBaseVersion: 0, actorId: b.ownerId });
  });

  afterAll(async () => {
    if (!E2E_DB_ENABLED) return;
    await prisma.company.deleteMany({ where: { id: { in: created } } });
    await app.close();
  });

  it('requires authentication', async () => {
    if (!E2E_DB_ENABLED) return;
    await request(app.getHttpServer()).get('/api/v1/me/config').expect(401);
    await request(app.getHttpServer()).put('/api/v1/me/preferences/sidebar').send({}).expect(401);
  });

  it("with no published config, the sidebar equals today's web sidebar for each user", async () => {
    if (!E2E_DB_ENABLED) return;
    const owner = await getConfig(a.ownerEmail);
    expect(owner.body.version).toBe(0);
    expect(sidebarPaths(owner.body)).toEqual(expectedSidebar(true, new Set()));
    expect(owner.body.sidebar.flatMap((s) => s.children).every((c) => !c.locked)).toBe(true);
    for (const key of MODULE_KEYS) {
      expect(owner.body.modules[key].label).toBe(MODULE_REGISTRY[key].label);
      expect(owner.body.modules[key].config).toEqual(MODULE_REGISTRY[key].defaults);
    }
    expect(owner.body.modules['purchase-orders'].usable).toBe(true);

    const viewer = await getConfig(viewerEmail);
    expect(sidebarPaths(viewer.body)).toEqual(expectedSidebar(false, viewerPermissions));
    expect(viewer.body.sidebar.flatMap((s) => s.children).map((c) => c.path)).not.toContain('/dashboard');
    expect(viewer.body.modules.dashboard.usable).toBe(false);
    expect(viewer.body.modules.dashboard.blockedBy).toBe('role');
    for (const body of [owner.body, viewer.body]) {
      for (const [key, mod] of Object.entries(body.modules)) {
        expect({ key, consistent: mod.usable === (mod.blockedBy === null) }).toEqual({ key, consistent: true });
      }
    }
    expect(Object.values(viewer.body.modules).some((m) => m.blockedBy === 'permission')).toBe(true);
  });

  it('applies the published config: disabled modules hidden, labels renamed, plan-gated links locked', async () => {
    if (!E2E_DB_ENABLED) return;
    const { body } = await getConfig(b.ownerEmail);
    expect(body.version).toBe(1);
    const links = body.sidebar.flatMap((s) => s.children);
    expect(links.map((l) => l.key)).not.toContain('contracts');
    expect(body.modules.contracts).toMatchObject({ usable: false, blockedBy: 'config' });
    expect(links.find((l) => l.key === 'invoices')).toMatchObject({ label: 'Billing Desk', locked: true });
    expect(body.modules.invoices).toMatchObject({ label: 'Billing Desk', usable: false, blockedBy: 'plan' });
    // TRIAL: still listed (as today, behind an upgrade prompt) but not usable.
    expect(links.find((l) => l.key === 'purchase-orders')).toMatchObject({ locked: true });
    expect(body.modules['purchase-orders']).toMatchObject({ usable: false, blockedBy: 'plan', config: { mandatoryFields: ['remarks'] } });
    expect(links.find((l) => l.key === 'products')).toMatchObject({ locked: false });
  });

  it("never includes another company's data", async () => {
    if (!E2E_DB_ENABLED) return;
    await authed(app, await token(b.ownerEmail)).put('/api/v1/me/preferences/sidebar').send({ pinned: ['returns'] }).expect(200);
    const { body } = await getConfig(a.ownerEmail);
    const json = JSON.stringify(body);
    expect(body.version).toBe(0);
    expect(body.modules.contracts.usable).toBe(true);
    expect(json).not.toContain('Billing Desk');
    expect(json).not.toContain(b.companyId);
    expect(body.preferences).not.toHaveProperty('sidebar');
  });

  it('stores preferences with the strict schema and never hides mandatory columns', async () => {
    if (!E2E_DB_ENABLED) return;
    const bAgent = authed(app, await token(b.ownerEmail));
    const bad = await bAgent.put('/api/v1/me/preferences/purchase-orders').send({ enabled: false }).expect(422);
    expect(bad.body.error.code).toBe('INVALID_PREFERENCES');
    await bAgent.put('/api/v1/me/preferences/not-a-module').send({ pinned: [] }).expect(422);

    const saved = await bAgent
      .put('/api/v1/me/preferences/purchase-orders')
      .send({ hiddenColumns: ['remarks', 'lineCategory'], columnOrder: ['poNumber'] })
      .expect(200);
    expect(unwrap(saved.body)).toEqual({ hiddenColumns: ['remarks', 'lineCategory'], columnOrder: ['poNumber'] });

    const { body } = await getConfig(b.ownerEmail);
    expect(body.preferences['purchase-orders']).toEqual({ hiddenColumns: ['lineCategory'], columnOrder: ['poNumber'] });
    expect(body.preferences.sidebar).toEqual({ pinned: ['returns'] });
  });

  it('answers 304 to If-None-Match until something the user sees changes', async () => {
    if (!E2E_DB_ENABLED) return;
    const agent = () => authed(app, tokens.get(a.ownerEmail)!);
    const first = await getConfig(a.ownerEmail);
    expect(first.etag).toMatch(/^"[\w-]+"$/);

    const notModified = await agent().get('/api/v1/me/config').set('If-None-Match', first.etag).expect(304);
    expect(notModified.text).toBe('');
    await agent().get('/api/v1/me/config').set('If-None-Match', `W/${first.etag}, "other"`).expect(304);

    await agent().put('/api/v1/me/preferences/sidebar').send({ pinned: ['sales'] }).expect(200);
    const changed = await agent().get('/api/v1/me/config').set('If-None-Match', first.etag).expect(200);
    expect(changed.headers.etag).not.toBe(first.etag);
    expect(unwrap<MeConfigResponse>(changed.body).preferences.sidebar).toEqual({ pinned: ['sales'] });
  });
});
