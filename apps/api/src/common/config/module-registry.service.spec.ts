import { SubscriptionPlan } from '@prisma/client';
import { compileSnapshot } from './config-snapshot';
import { ModuleKey } from './module-registry';
import { ModuleRegistryService } from './module-registry.service';

const service = new ModuleRegistryService();

function config(disabled: ModuleKey[] = []) {
  const { snapshot, issues } = compileSnapshot([], new Set(), 1);
  expect(issues).toEqual([]);
  const modules = structuredClone(snapshot.company);
  for (const key of disabled) modules[key].enabled = false;
  return { modules };
}

const all = new Set(['purchase_order:read', 'product:read', 'supplier:read', 'report:view', 'billing:manage']);

describe('ModuleRegistryService.isUsable', () => {
  it('is true when enabled, dependencies enabled, plan allows and permission held', () => {
    expect(service.isUsable('purchase-orders', config(), SubscriptionPlan.PRO, all)).toBe(true);
  });

  it('is false when the module is disabled in config', () => {
    expect(service.isUsable('purchase-orders', config(['purchase-orders']), SubscriptionPlan.PLUS, all)).toBe(false);
  });

  it('is false when a dependency is disabled in config', () => {
    expect(service.isUsable('purchase-orders', config(['suppliers']), SubscriptionPlan.PLUS, all)).toBe(false);
  });

  it('is false when enabled in config but blocked by the plan', () => {
    expect(service.isUsable('purchase-orders', config(), SubscriptionPlan.TRIAL, all)).toBe(false);
    expect(service.isUsable('reports', config(), SubscriptionPlan.TRIAL, all)).toBe(false);
  });

  it('is false when enabled in config but the user lacks the permission', () => {
    const noPo = new Set([...all].filter((p) => p !== 'purchase_order:read'));
    expect(service.isUsable('purchase-orders', config(), SubscriptionPlan.PLUS, noPo)).toBe(false);
  });

  it('needs no plan or permission for ungated modules', () => {
    expect(service.isUsable('barcode-print', config(), SubscriptionPlan.TRIAL, new Set())).toBe(true);
    expect(service.isUsable('settings', config(), SubscriptionPlan.TRIAL, new Set())).toBe(true);
  });

  it('lists usable modules, so config only ever narrows plan and permissions', () => {
    const trialNoPerms = service.usableModules(config(), SubscriptionPlan.TRIAL, new Set());
    expect(trialNoPerms).toEqual(expect.arrayContaining(['dashboard', 'goods-receipts', 'barcode-print', 'settings']));
    expect(trialNoPerms).not.toContain('purchase-orders');

    const plusAll = service.usableModules(config(), SubscriptionPlan.PLUS, all);
    const narrowed = service.usableModules(config(['products']), SubscriptionPlan.PLUS, all);
    expect(narrowed.every((key) => plusAll.includes(key))).toBe(true);
    expect(narrowed).not.toContain('products');
    expect(narrowed).not.toContain('purchase-orders');
  });

  it('looks modules up by key', () => {
    expect(service.get('rfqs')?.label).toBe('Quote Requests');
    expect(service.get('nope')).toBeUndefined();
    expect(service.all()).toHaveLength(29);
  });
});
