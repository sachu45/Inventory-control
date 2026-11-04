import { MODULE_KEYS, MODULE_REGISTRY } from './module-registry';
import {
  CONFIG_SNAPSHOT_SCHEMA_VERSION,
  DraftRow,
  compileSnapshot,
  diffJson,
  diffSnapshots,
  draftsFromSnapshot,
} from './config-snapshot';

const SHOP = '11111111-1111-1111-1111-111111111111';
const OTHER_SHOP = '22222222-2222-2222-2222-222222222222';
const shops = new Set([SHOP]);

const company = (moduleKey: string, enabled: boolean | null, config: unknown = {}): DraftRow => ({
  shopId: null,
  moduleKey,
  enabled,
  config,
});
const shop = (moduleKey: string, enabled: boolean | null, config: unknown = {}, shopId = SHOP): DraftRow => ({
  shopId,
  moduleKey,
  enabled,
  config,
});

describe('compileSnapshot', () => {
  it('with no drafts reproduces registry defaults', () => {
    const { snapshot, issues } = compileSnapshot([], shops, 1);
    expect(issues).toEqual([]);
    expect(snapshot.schemaVersion).toBe(CONFIG_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.version).toBe(1);
    expect(snapshot.shops).toEqual({});
    for (const key of MODULE_KEYS) {
      expect(snapshot.company[key]).toEqual({
        enabled: MODULE_REGISTRY[key].defaultEnabled,
        config: MODULE_REGISTRY[key].defaults,
      });
    }
  });

  it('merges partial draft config over defaults and applies enabled', () => {
    const { snapshot, issues } = compileSnapshot(
      [company('purchase-orders', null, { mandatoryFields: ['remarks'] }), company('contracts', false)],
      shops,
      2,
    );
    expect(issues).toEqual([]);
    expect(snapshot.company['purchase-orders']).toEqual({
      enabled: true,
      config: { mandatoryFields: ['remarks'], hiddenFields: [] },
    });
    expect(snapshot.company.contracts.enabled).toBe(false);
  });

  it('reports every problem at once, with paths', () => {
    const { issues } = compileSnapshot(
      [
        company('purchase-orders', null, { hiddenFields: ['supplier'], approvalLevels: 3 }),
        company('settings', false),
        company('products', false),
        company('ghost-module', true),
        company('reports', null, 'not-an-object'),
      ],
      shops,
      1,
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'modules.purchase-orders.config',
        'modules.purchase-orders.config.hiddenFields.0',
        'modules.settings.enabled',
        'modules.ghost-module',
        'modules.reports.config',
        'modules.purchase-orders.enabled',
        'modules.rfqs.enabled',
        'modules.barcode-print.enabled',
      ]),
    );
    expect(issues.find((i) => i.path === 'modules.rfqs.enabled')?.message).toMatch(/requires Products/);
  });

  it('accepts a dependency chain that is disabled together', () => {
    const disabled = ['supplier-bills', 'supplier-payments'].map((k) => company(k, false));
    expect(compileSnapshot(disabled, shops, 1).issues).toEqual([]);
    expect(compileSnapshot([company('supplier-bills', false)], shops, 1).issues.map((i) => i.path)).toEqual([
      'modules.supplier-payments.enabled',
    ]);
  });

  it('rejects shop overrides of keys that are not shopOverridable', () => {
    const { issues } = compileSnapshot([shop('purchase-orders', null, { mandatoryFields: ['remarks'] })], shops, 1);
    expect(issues).toEqual([
      { path: `shops.${SHOP}.purchase-orders.config.mandatoryFields`, message: expect.stringMatching(/per shop/) },
    ]);
  });

  it('keeps valid shop enable/disable overrides and checks dependencies per shop', () => {
    const ok = compileSnapshot([shop('contracts', false)], shops, 1);
    expect(ok.issues).toEqual([]);
    expect(ok.snapshot.shops).toEqual({ [SHOP]: { contracts: { enabled: false, config: {} } } });

    const broken = compileSnapshot([shop('invoices', false)], shops, 1);
    expect(broken.issues.map((i) => i.path).sort()).toEqual([
      `shops.${SHOP}.eway-bills.enabled`,
      `shops.${SHOP}.payments.enabled`,
    ]);
  });

  it('rejects disabling an always-enabled module for a shop', () => {
    const { issues } = compileSnapshot([shop('upgrade', false)], shops, 1);
    expect(issues.map((i) => i.path)).toEqual([`shops.${SHOP}.upgrade.enabled`]);
  });

  it("rejects drafts for another company's shop", () => {
    const { issues, snapshot } = compileSnapshot([shop('contracts', false, {}, OTHER_SHOP)], shops, 1);
    expect(issues).toEqual([{ path: `shops.${OTHER_SHOP}`, message: 'Shop does not belong to this company' }]);
    expect(snapshot.shops).toEqual({});
  });

  it('drops empty shop rows that change nothing', () => {
    const { snapshot, issues } = compileSnapshot([shop('contracts', null)], shops, 1);
    expect(issues).toEqual([]);
    expect(snapshot.shops).toEqual({});
  });
});

describe('draftsFromSnapshot', () => {
  it('round-trips through compileSnapshot', () => {
    const { snapshot } = compileSnapshot(
      [
        company('purchase-orders', null, { mandatoryFields: ['remarks'], label: 'Buying' }),
        company('contracts', false),
        shop('rfqs', false),
      ],
      shops,
      4,
    );
    const again = compileSnapshot(draftsFromSnapshot(snapshot), shops, 4);
    expect(again.issues).toEqual([]);
    expect(again.snapshot).toEqual(snapshot);
  });
});

describe('diff', () => {
  it('lists leaf changes with dotted paths and treats arrays as values', () => {
    expect(
      diffJson(
        { a: { b: 1, list: [1, 2] }, gone: true },
        { a: { b: 2, list: [1, 2, 3] }, added: 'x' },
      ),
    ).toEqual([
      { path: 'a.b', before: 1, after: 2 },
      { path: 'a.list', before: [1, 2], after: [1, 2, 3] },
      { path: 'added', before: undefined, after: 'x' },
      { path: 'gone', before: true, after: undefined },
    ]);
    expect(diffJson({ a: [1] }, { a: [1] })).toEqual([]);
  });

  it('diffs a first publish against registry defaults, ignoring version numbers', () => {
    const { snapshot } = compileSnapshot([company('contracts', false)], shops, 1);
    expect(diffSnapshots(null, snapshot)).toEqual([
      { path: 'company.contracts.enabled', before: true, after: false },
    ]);
    const next = compileSnapshot([company('contracts', false)], shops, 2).snapshot;
    expect(diffSnapshots(snapshot, next)).toEqual([]);
  });
});
