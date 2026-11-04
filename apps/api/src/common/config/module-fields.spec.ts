import { getMetadataStorage } from 'class-validator';
import { Prisma } from '@prisma/client';

const { Decimal } = Prisma;
import { CreateInvoiceDto } from '../../modules/invoices/dto/create-invoice.dto';
import { CreateProductDto } from '../../modules/products/dto/create-product.dto';
import { CreatePurchaseOrderDto } from '../../modules/purchase-orders/dto/create-purchase-order.dto';
import { CreateSalesOrderDto } from '../../modules/sales-orders/dto/create-sales-order.dto';
import { compileSnapshot } from './config-snapshot';
import { LINE_FIELDS, applyWritePolicy, fieldPolicy, redactHidden } from './module-fields';
import { MODULE_REGISTRY, ModuleKey } from './module-registry';

const po = { mandatory: ['remarks', 'lineDescription'], hidden: ['rfqId', 'lineCategory'] };

describe('applyWritePolicy', () => {
  it('reports missing mandatory header and line fields on create', () => {
    const body = { supplier: 'S', remarks: '  ', items: [{ lineDescription: 'x' }, { orderQty: 1 }] };
    expect(applyWritePolicy('purchase-orders', po, body, 'create')).toEqual([
      { path: 'remarks', message: expect.stringContaining('remarks') },
      { path: 'items.1.lineDescription', message: expect.stringContaining('every line') },
    ]);
  });

  it('drops hidden header and line fields from the body', () => {
    const body: Record<string, unknown> = { remarks: 'r', rfqId: 'id', items: [{ lineDescription: 'x', lineCategory: 'Service' }] };
    expect(applyWritePolicy('purchase-orders', po, body, 'create')).toEqual([]);
    expect(body).toEqual({ remarks: 'r', items: [{ lineDescription: 'x' }] });
  });

  it('on update, checks only fields the request sends', () => {
    expect(applyWritePolicy('purchase-orders', po, { supplier: 'S' }, 'update')).toEqual([]);
    expect(applyWritePolicy('purchase-orders', po, { remarks: null }, 'update').map((i) => i.path)).toEqual(['remarks']);
    expect(applyWritePolicy('purchase-orders', po, { items: [{}] }, 'update').map((i) => i.path)).toEqual(['items.0.lineDescription']);
  });

  it('does nothing with the default config', () => {
    const { snapshot } = compileSnapshot([], new Set(), 1);
    for (const key of Object.keys(MODULE_REGISTRY) as ModuleKey[]) {
      const policy = fieldPolicy(key, { modules: snapshot.company });
      expect(policy).toEqual({ mandatory: [], hidden: [] });
      const body = { remarks: '', items: [{}] };
      expect(applyWritePolicy(key, policy, body, 'create')).toEqual([]);
      expect(body).toEqual({ remarks: '', items: [{}] });
    }
  });
});

describe('redactHidden', () => {
  const doc = () => ({ id: '1', remarks: 'r', rfqId: 'x', total: new Decimal(5), items: [{ id: 'l1', lineCategory: 'S', rate: 1 }] });

  it('removes hidden fields from a document and its lines without touching other values', () => {
    const out = redactHidden('purchase-orders', po, doc());
    expect(out).toEqual({ id: '1', remarks: 'r', total: new Decimal(5), items: [{ id: 'l1', rate: 1 }] });
    expect(out.total).toBeInstanceOf(Decimal);
  });

  it('handles lists, { data, meta } pages and response envelopes', () => {
    const page = { data: [doc()], meta: { total: 1 } };
    expect(redactHidden('purchase-orders', po, page).data[0]).not.toHaveProperty('rfqId');
    expect(redactHidden('purchase-orders', po, [doc()])[0].items[0]).not.toHaveProperty('lineCategory');
    const envelope = { success: true, data: { data: [doc()], meta: {} } };
    expect(redactHidden('purchase-orders', po, envelope).data.data[0]).not.toHaveProperty('rfqId');
  });

  it('passes files and buffers through, and returns the same value when nothing is hidden', () => {
    const buffer = Buffer.from('pdf');
    expect(redactHidden('purchase-orders', po, buffer)).toBe(buffer);
    const value = doc();
    expect(redactHidden('purchase-orders', { mandatory: [], hidden: [] }, value)).toBe(value);
  });
});

describe('registry field lists', () => {
  const createDtos: Partial<Record<ModuleKey, new () => object>> = {
    'purchase-orders': CreatePurchaseOrderDto,
    sales: CreateSalesOrderDto,
    products: CreateProductDto,
    invoices: CreateInvoiceDto,
  };

  it('every locked mandatory field is already required by the create DTO, so the default config keeps 400s', () => {
    const storage = getMetadataStorage();
    for (const [key, dto] of Object.entries(createDtos) as [ModuleKey, new () => object][]) {
      const metas = storage.getTargetValidationMetadatas(dto, '', true, false);
      for (const field of MODULE_REGISTRY[key].lockedMandatoryFields) {
        const own = metas.filter((m) => m.propertyName === field);
        expect({ key, field, validated: own.length > 0 }).toEqual({ key, field, validated: true });
        expect({ key, field, optional: own.some((m) => m.type === 'conditionalValidation') }).toEqual({ key, field, optional: false });
      }
    }
  });

  it('line fields are customizable fields of their module', () => {
    for (const [key, fields] of Object.entries(LINE_FIELDS) as [ModuleKey, string[]][]) {
      for (const field of fields) expect(MODULE_REGISTRY[key].customizableFields).toContain(field);
    }
  });
});
