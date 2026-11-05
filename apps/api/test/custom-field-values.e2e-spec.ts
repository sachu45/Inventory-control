import { randomUUID } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed, grLineItem, login, todayDateString, uniqueCode, unwrap } from './helpers/e2e-http';
import { seedWorkflowMasterData, type WorkflowContext } from './helpers/workflow-fixture';

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@retailims.com';
const PASSWORD = 'E2eFields@123';

type Row = { id: string; customFields?: Record<string, unknown> | null };

/** Custom field values (#167): enforcement on writes and role filtering on reads, as the API serves them. */
describe('Custom field values (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let ctx: WorkflowContext;
  let salesToken: string;
  let other: WorkflowContext;
  const previousAllowlist = process.env.PLATFORM_ADMIN_EMAILS;
  jest.setTimeout(120_000);

  const MODULES = ['products', 'suppliers', 'customers', 'purchase-orders', 'goods-receipts', 'sales', 'goods-issues', 'invoices'];
  const admin = () => authed(app, adminToken);
  const owner = () => authed(app, ctx.token);
  const sales = () => authed(app, salesToken);

  const define = (companyId: string, body: Record<string, unknown>) =>
    admin().post(`/api/v1/platform/tenants/${companyId}/draft/custom-fields`).send({ fieldType: 'text', label: 'Field', ...body }).expect(201);

  const publish = async (companyId: string) => {
    const versions = unwrap<{ version: number }[]>((await admin().get(`/api/v1/platform/tenants/${companyId}/versions`).expect(200)).body);
    const expectedBaseVersion = Math.max(0, ...versions.map((v) => v.version));
    await admin().post(`/api/v1/platform/tenants/${companyId}/publish`).send({ expectedBaseVersion }).expect(201);
  };

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    adminToken = (await login(app)).accessToken;
    ctx = await seedWorkflowMasterData(app);
    other = await seedWorkflowMasterData(app);

    const salesRole = await prisma.role.findFirstOrThrow({ where: { name: RoleName.SALES } });
    const email = `sales-${randomUUID().slice(0, 8)}@e2e.local`;
    await prisma.user.create({
      data: { name: 'Sales', email, passwordHash: await bcrypt.hash(PASSWORD, 4), roleId: salesRole.id, shopId: ctx.shopId, isActive: true },
    });
    salesToken = (await login(app, email, PASSWORD)).accessToken;

    for (const moduleKey of MODULES) await define(ctx.companyId, { moduleKey, fieldKey: 'note', label: 'Note', validation: { maxLength: 20 } });
    await define(ctx.companyId, { moduleKey: 'products', fieldKey: 'cost_code', label: 'Cost code', readRoles: ['OWNER', 'ADMIN'], writeRoles: ['OWNER', 'ADMIN'] });
    await define(ctx.companyId, { moduleKey: 'products', fieldKey: 'weight', label: 'Weight', fieldType: 'number', validation: { min: 0 } });
    await define(ctx.companyId, {
      moduleKey: 'products',
      fieldKey: 'grade',
      label: 'Grade',
      fieldType: 'select',
      defaultValue: 'a',
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    });
    await define(ctx.companyId, { moduleKey: 'goods-issues', fieldKey: 'approved_by', label: 'Approved by', writeRoles: ['OWNER'] });
    await publish(ctx.companyId);
  });

  afterAll(async () => {
    if (!E2E_DB_ENABLED) return;
    process.env.PLATFORM_ADMIN_EMAILS = previousAllowlist;
    await app.close();
  });

  const productBody = (over: Record<string, unknown> = {}) => {
    const code = uniqueCode('CF');
    return {
      productCode: `SKU-${code}`.slice(0, 40),
      description: `Custom ${code}`,
      uom: 'PCS',
      category: 'e2e',
      purchasePrice: 10,
      sellingPrice: 20,
      plants: [{ shopId: ctx.shopId, openingStock: 0, minStockLevel: 0 }],
      ...over,
    };
  };

  /** A minimal create and, where it exists, update for each module: every write route must store the values. */
  const documents = () => {
    const today = todayDateString();
    const code = uniqueCode('CF');
    return [
      { url: 'products', create: () => productBody() },
      { url: 'suppliers', create: () => ({ supplierCode: `S-${code}`.slice(0, 30), supplierName: `S ${code}`, email: `s-${code.toLowerCase()}@e2e.local`, phone: '+94771234568' }) },
      { url: 'customers', create: () => ({ customerCode: `C-${code}`.slice(0, 30), customerName: `C ${code}`, email: `c-${code.toLowerCase()}@e2e.local`, phone: '+94771234569', shopId: ctx.shopId }) },
      { url: 'purchase-orders', create: () => ({ poDate: today, shopId: ctx.shopId, supplier: 'E2E Supplier', items: [{ productId: ctx.productId, orderQty: 10, rate: 5 }] }) },
      {
        url: 'goods-receipts',
        create: () => ({ grDate: today, shopId: ctx.shopId, supplierName: 'E2E Supplier', items: [grLineItem({ productId: ctx.productId, storageLocationId: ctx.storageLocationId, quantity: 1, purchaseRate: 5 })] }),
      },
      { url: 'sales-orders', create: () => ({ shopId: ctx.shopId, orderDate: today, customerId: ctx.customerId, items: [{ productId: ctx.productId, quantity: 1, uom: 'PCS', unitPrice: 10 }] }) },
      { url: 'goods-issues', create: () => ({ giDate: today, shopId: ctx.shopId, issueReason: 'E2E', items: [{ productId: ctx.productId, quantity: 1, uom: 'PCS' }] }) },
      { url: 'invoices', create: () => ({ shopId: ctx.shopId, customerId: ctx.customerId, invoiceDate: today, totalValue: 100 }), noUpdate: true },
    ];
  };

  it('every module stores valid values, and refuses unknown or invalid ones with 422', async () => {
    if (!E2E_DB_ENABLED) return;
    // Goods issues need stock on hand.
    const receipt = unwrap<Row>(
      (
        await owner()
          .post('/api/v1/goods-receipts')
          .send({
            grDate: todayDateString(),
            shopId: ctx.shopId,
            supplierName: 'E2E Supplier',
            items: [grLineItem({ productId: ctx.productId, storageLocationId: ctx.storageLocationId, quantity: 50, purchaseRate: 5 })],
          })
          .expect(201)
      ).body,
    );
    await owner().post(`/api/v1/goods-receipts/${receipt.id}/post`).expect(201);

    for (const doc of documents()) {
      const url = `/api/v1/${doc.url}`;
      const made = await owner().post(url).send({ ...doc.create(), customFields: { note: 'first' } });
      expect({ url, status: made.status, body: made.status === 201 ? null : made.body }).toEqual({ url, status: 201, body: null });
      const row = unwrap<Row>(made.body);
      expect({ url, note: row.customFields?.note }).toEqual({ url, note: 'first' });

      // Forms and table columns read from the list, so it must carry the values too.
      const listed = unwrap<Row[] | { data?: Row[]; items?: Row[] }>((await owner().get(url).expect(200)).body);
      const listedRows = Array.isArray(listed) ? listed : (listed.data ?? listed.items ?? []);
      expect({ url, note: listedRows.find((r) => r.id === row.id)?.customFields?.note }).toEqual({ url, note: 'first' });

      await owner().post(url).send({ ...doc.create(), customFields: { nope: 1 } }).expect(422);
      await owner().post(url).send({ ...doc.create(), customFields: { note: 'x'.repeat(21) } }).expect(422);
      await owner().post(url).send({ ...doc.create(), customFields: { note: 5 } }).expect(422);
      await owner().post(url).send({ ...doc.create(), customFields: 'nope' }).expect(422);

      if (doc.noUpdate) continue;
      await owner().patch(`${url}/${row.id}`).send({ customFields: { note: 'x'.repeat(21) } }).expect(422);
      const updated = await owner().patch(`${url}/${row.id}`).send({ customFields: { note: 'second' } });
      expect({ url, status: updated.status, body: updated.status === 200 ? null : updated.body }).toEqual({ url, status: 200, body: null });
      expect(unwrap<Row>(updated.body).customFields?.note).toBe('second');
    }
  });

  it('applies types without coercion, and defaults on create', async () => {
    if (!E2E_DB_ENABLED) return;
    const made = unwrap<Row>((await owner().post('/api/v1/products').send(productBody({ customFields: { weight: 2.5 } })).expect(201)).body);
    expect(made.customFields).toEqual({ weight: 2.5, grade: 'a' });

    await owner().post('/api/v1/products').send(productBody({ customFields: { weight: '2.5' } })).expect(422);
    await owner().post('/api/v1/products').send(productBody({ customFields: { weight: -1 } })).expect(422);
    await owner().post('/api/v1/products').send(productBody({ customFields: { grade: 'zzz' } })).expect(422);
  });

  it('a role without read access never receives the field: detail, list, and other routes that include the record', async () => {
    if (!E2E_DB_ENABLED) return;
    const made = unwrap<Row>((await owner().post('/api/v1/products').send(productBody({ customFields: { note: 'public', cost_code: 'SECRET-123' } })).expect(201)).body);
    expect(made.customFields?.cost_code).toBe('SECRET-123');

    const asSales = await sales().get(`/api/v1/products/${made.id}`).expect(200);
    expect(unwrap<Row>(asSales.body).customFields?.note).toBe('public');
    expect(JSON.stringify(asSales.body)).not.toContain('SECRET-123');

    const list = await sales().get('/api/v1/products').expect(200);
    expect(JSON.stringify(list.body)).not.toContain('SECRET-123');

    // The owner sees it on detail.
    const asOwner = await owner().get(`/api/v1/products/${made.id}`).expect(200);
    expect(unwrap<Row>(asOwner.body).customFields?.cost_code).toBe('SECRET-123');

    // A document embedding the product does not carry the product's values, even for the owner.
    const po = unwrap<Row>((await owner().post('/api/v1/purchase-orders').send({ poDate: todayDateString(), shopId: ctx.shopId, supplier: 'E2E', items: [{ productId: made.id, orderQty: 1, rate: 5 }] }).expect(201)).body);
    const detail = await owner().get(`/api/v1/purchase-orders/${po.id}`).expect(200);
    expect(JSON.stringify(detail.body)).not.toContain('SECRET-123');
  });

  it('a role not in writeRoles cannot set the field, and an update keeps what it cannot see', async () => {
    if (!E2E_DB_ENABLED) return;
    const issue = { giDate: todayDateString(), shopId: ctx.shopId, issueReason: 'E2E', items: [{ productId: ctx.productId, quantity: 1, uom: 'PCS' }] };
    const denied = await sales().post('/api/v1/goods-issues').send({ ...issue, customFields: { approved_by: 'me' } }).expect(422);
    expect(JSON.stringify(denied.body)).toContain('customFields.approved_by');
    const draft = unwrap<Row>((await sales().post('/api/v1/goods-issues').send({ ...issue, customFields: { note: 'from sales' } }).expect(201)).body);
    await owner().patch(`/api/v1/goods-issues/${draft.id}`).send({ customFields: { approved_by: 'owner' } }).expect(200);
    const merged = unwrap<Row>((await sales().patch(`/api/v1/goods-issues/${draft.id}`).send({ customFields: { note: 'edited by sales' } }).expect(200)).body);
    expect(merged.customFields).toEqual({ note: 'edited by sales', approved_by: 'owner' });

    const made = unwrap<Row>((await owner().post('/api/v1/products').send(productBody({ customFields: { note: 'one', cost_code: 'KEEP-ME' } })).expect(201)).body);

    const updated = unwrap<Row>((await owner().patch(`/api/v1/products/${made.id}`).send({ customFields: { note: 'three' } }).expect(200)).body);
    expect(updated.customFields).toMatchObject({ note: 'three', cost_code: 'KEEP-ME' });

    // An update that does not mention custom fields changes none of them.
    await owner().patch(`/api/v1/products/${made.id}`).send({ description: 'Renamed' }).expect(200);
    const stored = await prisma.product.findUniqueOrThrow({ where: { id: made.id }, select: { customFields: true } });
    expect(stored.customFields).toMatchObject({ note: 'three', cost_code: 'KEEP-ME' });
  });

  it('required applies to new and edited records; archived fields are hidden and not validated, with values kept', async () => {
    if (!E2E_DB_ENABLED) return;
    const tenant = await seedWorkflowMasterData(app);
    const api = authed(app, tenant.token);
    const body = (over: Record<string, unknown> = {}) => {
      const code = uniqueCode('RQ');
      return { productCode: `SKU-${code}`.slice(0, 40), description: code, uom: 'PCS', category: 'e2e', purchasePrice: 1, sellingPrice: 2, plants: [{ shopId: tenant.shopId, openingStock: 0, minStockLevel: 0 }], ...over };
    };
    const base = `/api/v1/platform/tenants/${tenant.companyId}/draft/custom-fields`;
    const field = unwrap<{ id: string }>((await admin().post(base).send({ moduleKey: 'products', fieldKey: 'batch_ref', label: 'Batch ref', fieldType: 'text' }).expect(201)).body);
    await publish(tenant.companyId);

    const before = unwrap<Row>((await api.post('/api/v1/products').send(body()).expect(201)).body);
    const withValue = unwrap<Row>((await api.post('/api/v1/products').send(body({ customFields: { batch_ref: 'B1' } })).expect(201)).body);

    await admin().patch(`${base}/${field.id}`).send({ required: true, requiredRollout: 'new_and_edited' }).expect(200);
    // Not live until published.
    await api.post('/api/v1/products').send(body()).expect(201);
    await publish(tenant.companyId);

    await api.post('/api/v1/products').send(body()).expect(422);
    await api.post('/api/v1/products').send(body({ customFields: { batch_ref: 'B2' } })).expect(201);
    // Existing records are untouched until edited, and an edit must then supply it.
    await api.get(`/api/v1/products/${before.id}`).expect(200);
    await api.patch(`/api/v1/products/${before.id}`).send({ description: 'Edited' }).expect(422);
    await api.patch(`/api/v1/products/${before.id}`).send({ description: 'Edited', customFields: { batch_ref: 'B3' } }).expect(200);
    await api.patch(`/api/v1/products/${withValue.id}`).send({ description: 'Edited' }).expect(200);

    await admin().post(`${base}/${field.id}/archive`).expect(200);
    await publish(tenant.companyId);
    await api.post('/api/v1/products').send(body()).expect(201);
    await api.post('/api/v1/products').send(body({ customFields: { batch_ref: 'B4' } })).expect(422);
    expect(unwrap<Row>((await api.get(`/api/v1/products/${withValue.id}`).expect(200)).body).customFields).toEqual({});
    const stored = await prisma.product.findUniqueOrThrow({ where: { id: withValue.id }, select: { customFields: true } });
    expect(stored.customFields).toEqual({ batch_ref: 'B1' });

    await admin().post(`${base}/${field.id}/restore`).expect(200);
    await publish(tenant.companyId);
    expect(unwrap<Row>((await api.get(`/api/v1/products/${withValue.id}`).expect(200)).body).customFields).toEqual({ batch_ref: 'B1' });
  });

  it('a company with no published fields behaves as before', async () => {
    if (!E2E_DB_ENABLED) return;
    const api = authed(app, other.token);
    const code = uniqueCode('NO');
    const body = { productCode: `SKU-${code}`.slice(0, 40), description: code, uom: 'PCS', category: 'e2e', purchasePrice: 1, sellingPrice: 2, plants: [{ shopId: other.shopId, openingStock: 0, minStockLevel: 0 }] };
    const made = unwrap<Row>((await api.post('/api/v1/products').send(body).expect(201)).body);
    const stored = await prisma.product.findUniqueOrThrow({ where: { id: made.id }, select: { customFields: true } });
    expect(stored.customFields).toBeNull();
    await api.patch(`/api/v1/products/${made.id}`).send({ description: 'Edited' }).expect(200);
    expect(unwrap<Row>((await api.get(`/api/v1/products/${made.id}`).expect(200)).body).customFields).toBeNull();
    await api.post('/api/v1/products').send({ ...body, productCode: `${body.productCode}X`, customFields: { note: 'x' } }).expect(422);
  });

  it('another company\'s published fields do not apply', async () => {
    if (!E2E_DB_ENABLED) return;
    const res = await authed(app, other.token).post('/api/v1/suppliers').send({ supplierCode: uniqueCode('S').slice(0, 30), supplierName: 'S', email: `${uniqueCode('s').toLowerCase()}@e2e.local`, phone: '+94771234568', customFields: { note: 'x' } });
    expect(res.status).toBe(422);
  });

  it('/me/config gives forms the fields this role may read, and says which it may write', async () => {
    if (!E2E_DB_ENABLED) return;
    type Me = { modules: Record<string, { config: { customFields?: { fieldKey: string; writable: boolean; readRoles?: unknown }[] } }> };
    const forOwner = unwrap<Me>((await owner().get('/api/v1/me/config').expect(200)).body).modules.products.config.customFields ?? [];
    expect(forOwner.map((f) => f.fieldKey)).toEqual(expect.arrayContaining(['note', 'cost_code', 'weight', 'grade']));
    expect(forOwner.every((f) => f.writable && f.readRoles === undefined)).toBe(true);

    const forSales = unwrap<Me>((await sales().get('/api/v1/me/config').expect(200)).body).modules.products.config.customFields ?? [];
    expect(forSales.map((f) => f.fieldKey)).toEqual(expect.arrayContaining(['note', 'weight', 'grade']));
    expect(forSales.map((f) => f.fieldKey)).not.toContain('cost_code');

    const none = unwrap<Me>((await authed(app, other.token).get('/api/v1/me/config').expect(200)).body);
    expect(none.modules.products.config.customFields).toBeUndefined();
  });
});
