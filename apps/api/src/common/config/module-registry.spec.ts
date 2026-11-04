import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  MODULE_KEYS,
  MODULE_REGISTRY,
  ModuleDefinition,
  ModuleKey,
  SidebarEntry,
  deriveSidebar,
  isModuleKey,
} from './module-registry';

const modules = MODULE_KEYS.map((key) => MODULE_REGISTRY[key]);
const WEB_SRC = resolve(__dirname, '../../../../web/src');

describe('MODULE_REGISTRY', () => {
  it('has exactly one entry per module key, keyed by its own key', () => {
    expect(Object.keys(MODULE_REGISTRY).sort()).toEqual([...MODULE_KEYS].sort());
    for (const [key, mod] of Object.entries(MODULE_REGISTRY)) expect(mod.key).toBe(key);
  });

  it.each(modules.map((m) => [m.key, m] as const))('%s: defaults parse against configSchema', (_k: string, mod: ModuleDefinition) => {
    expect(mod.configSchema.safeParse(mod.defaults).success).toBe(true);
  });

  it.each(modules.map((m) => [m.key, m] as const))('%s: configSchema rejects unknown keys', (_k: string, mod: ModuleDefinition) => {
    expect(mod.configSchema.safeParse({ ...mod.defaults, approvalLevels: 2 }).success).toBe(false);
  });

  it('every dependsOn key exists and no module depends on itself', () => {
    for (const mod of modules) {
      for (const dep of mod.dependsOn) {
        expect(isModuleKey(dep)).toBe(true);
        expect(dep).not.toBe(mod.key);
      }
    }
  });

  it('the dependency graph has no cycles', () => {
    const state = new Map<ModuleKey, 'visiting' | 'done'>();
    const visit = (key: ModuleKey, trail: ModuleKey[]) => {
      if (state.get(key) === 'done') return;
      if (state.get(key) === 'visiting') throw new Error(`cycle: ${[...trail, key].join(' -> ')}`);
      state.set(key, 'visiting');
      for (const dep of MODULE_REGISTRY[key].dependsOn) visit(dep, [...trail, key]);
      state.set(key, 'done');
    };
    expect(() => MODULE_KEYS.forEach((key) => visit(key, []))).not.toThrow();
  });

  it('no default-enabled module depends on a default-disabled one', () => {
    for (const mod of modules.filter((m) => m.defaultEnabled)) {
      for (const dep of mod.dependsOn) expect(MODULE_REGISTRY[dep].defaultEnabled).toBe(true);
    }
  });

  it('always-enabled modules are enabled by default and depend on nothing', () => {
    for (const mod of modules.filter((m) => m.alwaysEnabled)) {
      expect(mod.defaultEnabled).toBe(true);
      expect(mod.dependsOn).toEqual([]);
    }
  });

  it('customizable and locked mandatory fields never overlap', () => {
    for (const mod of modules) {
      const locked = new Set(mod.lockedMandatoryFields);
      expect(mod.customizableFields.filter((f) => locked.has(f))).toEqual([]);
    }
  });

  it('shopOverridable keys are settings keys', () => {
    const settingsKeys = ['mandatoryFields', 'hiddenFields', 'label'];
    for (const mod of modules) {
      for (const key of mod.shopOverridable) expect(settingsKeys).toContain(key);
    }
  });

  it('sidebar paths are unique', () => {
    const paths = modules.map((m) => m.sidebarPath);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('module settings schema', () => {
  const po = MODULE_REGISTRY['purchase-orders'];

  it('accepts customizable fields as mandatory or hidden', () => {
    expect(
      po.configSchema.safeParse({ mandatoryFields: ['remarks'], hiddenFields: ['lineCategory'], label: 'POs' })
        .success,
    ).toBe(true);
  });

  it('rejects hiding a locked mandatory field', () => {
    expect(po.configSchema.safeParse({ mandatoryFields: [], hiddenFields: ['supplier'] }).success).toBe(false);
  });

  it('rejects hiding a field that is also made mandatory', () => {
    const result = po.configSchema.safeParse({ mandatoryFields: ['remarks'], hiddenFields: ['remarks'] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/cannot be hidden/);
  });

  it('rejects fields that are not customizable', () => {
    expect(po.configSchema.safeParse({ mandatoryFields: ['madeUp'], hiddenFields: [] }).success).toBe(false);
  });

  it('allows no field names for a module without customizable fields', () => {
    const settings = MODULE_REGISTRY.settings.configSchema;
    expect(settings.safeParse({ mandatoryFields: [], hiddenFields: [] }).success).toBe(true);
    expect(settings.safeParse({ mandatoryFields: ['anything'], hiddenFields: [] }).success).toBe(false);
  });

  it('rejects a blank or overlong label', () => {
    expect(po.configSchema.safeParse({ ...po.defaults, label: '   ' }).success).toBe(false);
    expect(po.configSchema.safeParse({ ...po.defaults, label: 'x'.repeat(41) }).success).toBe(false);
  });
});

/** Reads the web app's hand-written SIDEBAR_SECTIONS, which the registry must reproduce. */
function readWebSidebar(): { id: string; title: string; children: SidebarEntry[] }[] {
  const source = readFileSync(resolve(WEB_SRC, 'lib/sidebar-navigation.ts'), 'utf8');
  const sectionIds = Object.fromEntries(
    [...source.matchAll(/^\s+(\w+): '([a-z-]+)',$/gm)].map(([, name, id]) => [name, id]),
  );
  const body = source.slice(source.indexOf('export const SIDEBAR_SECTIONS'));
  const sections = [...body.matchAll(/id: SidebarSectionId\.(\w+),\s*title: '([^']+)',\s*children: \[([\s\S]*?)\],\s*\}/g)];
  return sections.map(([, idName, title, children]) => ({
    id: sectionIds[idName],
    title,
    children: [...children.matchAll(/L\('([^']+)', '([^']+)', menuIcons\.(\w+)(?:, (\{.*\}))?\),?\s*$/gm)]
      .filter(([, , , , extra]) => !extra?.includes('requirePlatformAdmin'))
      .map(([, label, path, icon, extra = '']) => ({
        label,
        path,
        icon,
        permission: /permission: '([^']+)'/.exec(extra)?.[1] ?? null,
        requireOrgAdmin: extra.includes('requireOrgAdmin: true'),
      })),
  }));
}

describe('deriveSidebar', () => {
  it("reproduces today's web SIDEBAR_SECTIONS with registry defaults (platform admin excluded)", () => {
    const web = readWebSidebar();
    expect(web.length).toBeGreaterThan(0);
    expect(web.flatMap((s) => s.children).length).toBeGreaterThan(20);
    expect(deriveSidebar()).toEqual(web);
  });

  it('uses icon keys that exist in the web menuIcons map', () => {
    const iconMap = readFileSync(resolve(WEB_SRC, 'config/iconMap.ts'), 'utf8');
    const menuIcons = iconMap.slice(iconMap.indexOf('menuIcons'));
    for (const mod of modules) expect(menuIcons).toMatch(new RegExp(`\\b${mod.sidebarIcon}:`));
  });

  it('drops modules that are not passed in, and empty sections', () => {
    const derived = deriveSidebar([MODULE_REGISTRY.products, MODULE_REGISTRY.reports]);
    expect(derived.map((s) => s.id)).toEqual(['master-data', 'operations']);
    expect(derived.flatMap((s) => s.children.map((c) => c.path))).toEqual(['/products', '/reports']);
  });
});
