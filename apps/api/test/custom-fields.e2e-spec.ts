import { randomUUID } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed, login, unwrap } from './helpers/e2e-http';
import { seedWorkflowMasterData, type WorkflowContext } from './helpers/workflow-fixture';

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@retailims.com';

type Field = { id: string; fieldKey: string; fieldType: string; required: boolean; archivedAt: string | null };
type Snapshot = { customFields?: Record<string, { fieldKey: string; fieldType: string; label: string }[]> };

/** Custom field definitions (#167): the admin API, lifecycle rules and publishing. */
describe('Custom field definitions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let a: WorkflowContext;
  let b: WorkflowContext;
  const previousAllowlist = process.env.PLATFORM_ADMIN_EMAILS;
  jest.setTimeout(60_000);

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    adminToken = (await login(app)).accessToken;
    a = await seedWorkflowMasterData(app);
    b = await seedWorkflowMasterData(app);
  });

  afterAll(async () => {
    if (!E2E_DB_ENABLED) return;
    process.env.PLATFORM_ADMIN_EMAILS = previousAllowlist;
    await app.close();
  });

  const admin = () => authed(app, adminToken);
  const fieldsUrl = (companyId: string) => `/api/v1/platform/tenants/${companyId}/draft/custom-fields`;
  const key = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

  const create = async (companyId: string, body: Record<string, unknown>) =>
    unwrap<Field>((await admin().post(fieldsUrl(companyId)).send({ moduleKey: 'products', label: 'Field', fieldType: 'text', ...body }).expect(201)).body);

  const activeVersion = async (companyId: string) => {
    const versions = unwrap<{ version: number }[] | { items: { version: number }[] }>(
      (await admin().get(`/api/v1/platform/tenants/${companyId}/versions`).expect(200)).body,
    );
    const list = Array.isArray(versions) ? versions : versions.items;
    return Math.max(0, ...list.map((v) => v.version));
  };

  const publish = async (companyId: string) => {
    const expectedBaseVersion = await activeVersion(companyId);
    await admin().post(`/api/v1/platform/tenants/${companyId}/publish`).send({ expectedBaseVersion }).expect(201);
    return expectedBaseVersion + 1;
  };

  const published = async (companyId: string, version: number) =>
    unwrap<{ snapshot: Snapshot }>((await admin().get(`/api/v1/platform/tenants/${companyId}/versions/${version}`).expect(200)).body).snapshot;

  it('creates and lists fields, and refuses invalid or duplicate ones', async () => {
    if (!E2E_DB_ENABLED) return;
    const fieldKey = key('grade');
    const field = await create(a.companyId, { fieldKey });
    expect(field).toMatchObject({ fieldKey, fieldType: 'text', required: false, archivedAt: null });

    const inModule = unwrap<Field[]>((await admin().get(fieldsUrl(a.companyId)).query({ module: 'products' }).expect(200)).body);
    expect(inModule.map((f) => f.fieldKey)).toContain(fieldKey);
    const elsewhere = unwrap<Field[]>((await admin().get(fieldsUrl(a.companyId)).query({ module: 'suppliers' }).expect(200)).body);
    expect(elsewhere.map((f) => f.fieldKey)).not.toContain(fieldKey);

    const body = { moduleKey: 'products', label: 'L', fieldType: 'text' };
    await admin().post(fieldsUrl(a.companyId)).send({ ...body, fieldKey }).expect(409);
    await admin().post(fieldsUrl(a.companyId)).send({ ...body, fieldKey: 'Bad-Key' }).expect(422);
    await admin().post(fieldsUrl(a.companyId)).send({ ...body, fieldKey: key('x'), moduleKey: 'nope' }).expect(422);
    await admin().post(fieldsUrl(a.companyId)).send({ ...body, fieldKey: key('x'), moduleKey: 'rfqs' }).expect(422);
    await admin().post(fieldsUrl(a.companyId)).send({ ...body, fieldKey: key('x'), fieldType: 'select' }).expect(422);
    await admin().post(fieldsUrl(a.companyId)).send({ ...body, fieldKey: key('x'), required: 'false' }).expect(422);
    await admin().post(fieldsUrl(randomUUID())).send({ ...body, fieldKey: key('x') }).expect(404);
  });

  it('enforces the lifecycle rules on update', async () => {
    if (!E2E_DB_ENABLED) return;
    const url = (id: string) => `${fieldsUrl(a.companyId)}/${id}`;
    const field = await create(a.companyId, {
      fieldKey: key('kind'),
      fieldType: 'select',
      options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }],
    });

    // Identity is fixed.
    await admin().patch(url(field.id)).send({ fieldKey: 'other' }).expect(422);
    await admin().patch(url(field.id)).send({ moduleKey: 'suppliers' }).expect(422);

    // Options are archived, not removed.
    await admin().patch(url(field.id)).send({ options: [{ value: 'x', label: 'X' }] }).expect(409);
    await admin().patch(url(field.id)).send({ options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y', archived: true }] }).expect(200);
    await admin().patch(url(field.id)).send({ defaultValue: 'y' }).expect(422);
    await admin().patch(url(field.id)).send({ defaultValue: 'x', label: 'Renamed', sortOrder: 3 }).expect(200);

    // Required needs a stated rollout.
    await admin().patch(url(field.id)).send({ required: true }).expect(422);
    const required = unwrap<Field>((await admin().patch(url(field.id)).send({ required: true, requiredRollout: 'new_and_edited' }).expect(200)).body);
    expect(required.required).toBe(true);

    // Archived: not editable, restorable, and archive is idempotent.
    await admin().post(`${url(field.id)}/archive`).expect(200);
    const archived = unwrap<Field>((await admin().post(`${url(field.id)}/archive`).expect(200)).body);
    expect(archived.archivedAt).not.toBeNull();
    await admin().patch(url(field.id)).send({ label: 'x' }).expect(409);
    const restored = unwrap<Field>((await admin().post(`${url(field.id)}/restore`).expect(200)).body);
    expect(restored.archivedAt).toBeNull();

    // No route deletes a field.
    await admin().delete(url(field.id)).expect(404);
    await admin().patch(`${fieldsUrl(a.companyId)}/${randomUUID()}`).send({ label: 'x' }).expect(404);
  });

  it('locks the type once a record of that company holds a value, on tables with and without RLS', async () => {
    if (!E2E_DB_ENABLED) return;
    const fieldKey = key('size');
    const mine = await create(a.companyId, { fieldKey });
    const other = await create(b.companyId, { fieldKey });
    const url = (companyId: string, id: string) => `${fieldsUrl(companyId)}/${id}`;

    // Free to change while nothing holds a value.
    await admin().patch(url(a.companyId, mine.id)).send({ fieldType: 'number' }).expect(200);
    await admin().patch(url(a.companyId, mine.id)).send({ fieldType: 'text' }).expect(200);

    await prisma.product.update({ where: { id: a.productId }, data: { customFields: { [fieldKey]: 'large' } } });
    const locked = await admin().patch(url(a.companyId, mine.id)).send({ fieldType: 'number' }).expect(409);
    expect(JSON.stringify(locked.body)).toContain('CUSTOM_FIELD_TYPE_LOCKED');
    await admin().patch(url(a.companyId, mine.id)).send({ label: 'Still editable' }).expect(200);

    // Another company's value is no reason to lock this one.
    await admin().patch(url(b.companyId, other.id)).send({ fieldType: 'number' }).expect(200);

    // Customers have RLS: the same check through a tenant-scoped raw query.
    const customerField = await create(a.companyId, { fieldKey, moduleKey: 'customers' });
    await admin().patch(url(a.companyId, customerField.id)).send({ fieldType: 'number' }).expect(200);
    await prisma.customer.update({ where: { id: a.customerId }, data: { customFields: { [fieldKey]: 5 } } });
    await admin().patch(url(a.companyId, customerField.id)).send({ fieldType: 'text' }).expect(409);
  });

  it('takes effect on publish, leaves archived fields out, and rolls back', async () => {
    if (!E2E_DB_ENABLED) return;
    const tenant = await seedWorkflowMasterData(app);
    const keep = await create(tenant.companyId, { fieldKey: 'keep_me', label: 'Original' });
    const drop = await create(tenant.companyId, { fieldKey: 'drop_me' });
    const preview = unwrap<{ snapshot: Snapshot; issues: unknown[]; changes: { path: string }[] }>(
      (await admin().post(`/api/v1/platform/tenants/${tenant.companyId}/draft/preview`).expect(200)).body,
    );
    expect(preview.issues).toEqual([]);
    expect(preview.changes.map((c) => c.path)).toContain('customFields.products');

    const v1 = await publish(tenant.companyId);
    expect((await published(tenant.companyId, v1)).customFields?.products?.map((f) => f.fieldKey).sort()).toEqual(['drop_me', 'keep_me']);

    // A draft edit changes nothing already published.
    await admin().patch(`${fieldsUrl(tenant.companyId)}/${keep.id}`).send({ label: 'Edited' }).expect(200);
    await admin().post(`${fieldsUrl(tenant.companyId)}/${drop.id}/archive`).expect(200);
    await create(tenant.companyId, { fieldKey: 'added_later' });
    expect((await published(tenant.companyId, v1)).customFields?.products?.find((f) => f.fieldKey === 'keep_me')?.label).toBe('Original');

    const v2 = await publish(tenant.companyId);
    const second = (await published(tenant.companyId, v2)).customFields?.products ?? [];
    expect(second.map((f) => f.fieldKey).sort()).toEqual(['added_later', 'keep_me']);
    expect(second.find((f) => f.fieldKey === 'keep_me')?.label).toBe('Edited');

    // Rollback publishes v1's fields and resets the drafts to match; nothing is deleted.
    await admin().post(`/api/v1/platform/tenants/${tenant.companyId}/versions/${v1}/rollback`).send({ expectedBaseVersion: v2 }).expect(201);
    const v3 = (await published(tenant.companyId, v2 + 1)).customFields?.products ?? [];
    expect(v3.map((f) => f.fieldKey).sort()).toEqual(['drop_me', 'keep_me']);
    const drafts = unwrap<Field[]>((await admin().get(fieldsUrl(tenant.companyId)).expect(200)).body);
    const state = Object.fromEntries(drafts.map((f) => [f.fieldKey, f.archivedAt === null]));
    expect(state).toEqual({ keep_me: true, drop_me: true, added_later: false });
  });

  it('a rollback cannot restore a type that stored values no longer fit', async () => {
    if (!E2E_DB_ENABLED) return;
    const tenant = await seedWorkflowMasterData(app);
    const field = await create(tenant.companyId, { fieldKey: 'weight', fieldType: 'text' });
    const v1 = await publish(tenant.companyId);
    await admin().patch(`${fieldsUrl(tenant.companyId)}/${field.id}`).send({ fieldType: 'number' }).expect(200);
    const v2 = await publish(tenant.companyId);
    await prisma.product.update({ where: { id: tenant.productId }, data: { customFields: { weight: 12 } } });

    const res = await admin().post(`/api/v1/platform/tenants/${tenant.companyId}/versions/${v1}/rollback`).send({ expectedBaseVersion: v2 }).expect(422);
    expect(JSON.stringify(res.body)).toContain('customFields.products.weight.fieldType');
    expect(await activeVersion(tenant.companyId)).toBe(v2);
  });

  it('definitions are isolated between tenants, and each write is audited', async () => {
    if (!E2E_DB_ENABLED) return;
    const fieldKey = key('secret');
    const field = await create(a.companyId, { fieldKey });
    const asTenant = (companyId: string) =>
      TenantContext.run({ companyId, inRLSTx: false, systemAccess: false }, async () =>
        await prisma.customFieldDefinition.count({ where: { fieldKey } }),
      );
    expect(await asTenant(a.companyId)).toBe(1);
    expect(await asTenant(b.companyId)).toBe(0);

    // The admin route for B cannot reach A's field by id.
    await admin().patch(`${fieldsUrl(b.companyId)}/${field.id}`).send({ label: 'x' }).expect(404);
    await admin().post(`${fieldsUrl(b.companyId)}/${field.id}/archive`).expect(404);

    const audit = unwrap<{ items: { entityId: string; newValues: { platformAction?: string } | null }[] }>(
      (await admin().get(`/api/v1/platform/tenants/${a.companyId}/audit`).query({ type: 'config', take: 100 }).expect(200)).body,
    );
    expect(audit.items.find((row) => row.entityId === field.id)?.newValues?.platformAction).toBe('platform_custom_field_set');
  });
});
