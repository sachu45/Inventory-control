import { HttpException, HttpStatus } from '@nestjs/common';
import { isDeepStrictEqual } from 'util';
import { MODULE_KEYS, MODULE_REGISTRY, ModuleKey, ModuleSettings, isModuleKey } from './module-registry';

export const CONFIG_SNAPSHOT_SCHEMA_VERSION = 1;

export type ModuleState = { enabled: boolean; config: ModuleSettings };
export type ShopModuleOverride = { enabled?: boolean; config: Partial<ModuleSettings> };

export type PublishedSnapshot = {
  schemaVersion: typeof CONFIG_SNAPSHOT_SCHEMA_VERSION;
  version: number;
  company: Record<ModuleKey, ModuleState>;
  shops: Record<string, Partial<Record<ModuleKey, ShopModuleOverride>>>;
};

/** A `tenant_module_configs` row as the compiler needs it. */
export type DraftRow = {
  shopId: string | null;
  moduleKey: string;
  enabled: boolean | null;
  config: unknown;
};

export type ConfigIssue = { path: string; message: string };
export type ConfigChange = { path: string; before: unknown; after: unknown };

export class ConfigValidationException extends HttpException {
  constructor(public readonly details: ConfigIssue[]) {
    super({ message: 'Invalid configuration', code: 'CONFIG_INVALID', details }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

export class ConfigVersionConflictException extends HttpException {
  constructor(expectedBaseVersion: number, activeVersion: number) {
    super(
      {
        message: 'Configuration was published by someone else since this draft was previewed',
        code: 'CONFIG_VERSION_CONFLICT',
        expectedBaseVersion,
        activeVersion,
      },
      HttpStatus.CONFLICT,
    );
  }
}

export function latestVersionCacheKey(companyId: string): string {
  return `cfg:v1:${companyId}:latest`;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function issuesFrom(prefix: string, error: { issues: { path: PropertyKey[]; message: string }[] }): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
}

/**
 * Merges drafts over registry defaults and validates the result. Returns every
 * problem found rather than stopping at the first, so admins can fix them in one pass.
 */
export function compileSnapshot(
  drafts: readonly DraftRow[],
  companyShopIds: ReadonlySet<string>,
  version: number,
): { snapshot: PublishedSnapshot; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const companyRows = new Map<ModuleKey, DraftRow>();
  const shopRows = new Map<string, Map<ModuleKey, DraftRow>>();

  for (const row of drafts) {
    const scope = row.shopId === null ? `modules.${row.moduleKey}` : `shops.${row.shopId}.${row.moduleKey}`;
    if (!isModuleKey(row.moduleKey)) {
      issues.push({ path: scope, message: `Unknown module "${row.moduleKey}"` });
      continue;
    }
    if (row.shopId === null) {
      companyRows.set(row.moduleKey, row);
      continue;
    }
    if (!companyShopIds.has(row.shopId)) {
      issues.push({ path: `shops.${row.shopId}`, message: 'Shop does not belong to this company' });
      continue;
    }
    const forShop = shopRows.get(row.shopId) ?? new Map<ModuleKey, DraftRow>();
    forShop.set(row.moduleKey, row);
    shopRows.set(row.shopId, forShop);
  }

  const company = {} as Record<ModuleKey, ModuleState>;
  for (const key of MODULE_KEYS) {
    const mod = MODULE_REGISTRY[key];
    const row = companyRows.get(key);
    const enabled = row?.enabled ?? mod.defaultEnabled;
    let config = mod.defaults;
    const draftConfig = row?.config;
    if (row && isPlainObject(draftConfig)) {
      const parsed = mod.configSchema.safeParse({ ...mod.defaults, ...draftConfig });
      if (parsed.success) config = parsed.data;
      else issues.push(...issuesFrom(`modules.${key}.config`, parsed.error));
    } else if (row) {
      issues.push({ path: `modules.${key}.config`, message: 'Config must be an object' });
    }
    if (mod.alwaysEnabled && !enabled) {
      issues.push({ path: `modules.${key}.enabled`, message: `${mod.label} cannot be disabled` });
    }
    company[key] = { enabled, config };
  }
  issues.push(...dependencyIssues('modules', (key) => company[key].enabled));

  const shops: PublishedSnapshot['shops'] = {};
  for (const [shopId, rows] of shopRows) {
    const overrides: Partial<Record<ModuleKey, ShopModuleOverride>> = {};
    for (const [key, row] of rows) {
      const mod = MODULE_REGISTRY[key];
      const path = `shops.${shopId}.${key}`;
      if (!isPlainObject(row.config)) {
        issues.push({ path: `${path}.config`, message: 'Config must be an object' });
        continue;
      }
      const allowed = new Set<string>(mod.shopOverridable);
      const blocked = Object.keys(row.config).filter((k) => !allowed.has(k));
      for (const k of blocked) {
        issues.push({ path: `${path}.config.${k}`, message: `"${k}" cannot be overridden per shop` });
      }
      if (blocked.length) continue;
      const parsed = mod.configSchema.safeParse({ ...company[key].config, ...row.config });
      if (!parsed.success) {
        issues.push(...issuesFrom(`${path}.config`, parsed.error));
        continue;
      }
      if (mod.alwaysEnabled && row.enabled === false) {
        issues.push({ path: `${path}.enabled`, message: `${mod.label} cannot be disabled` });
      }
      if (row.enabled === null && Object.keys(row.config).length === 0) continue;
      overrides[key] = {
        ...(row.enabled === null ? {} : { enabled: row.enabled }),
        config: row.config as Partial<ModuleSettings>,
      };
    }
    issues.push(
      ...dependencyIssues(`shops.${shopId}`, (key) => overrides[key]?.enabled ?? company[key].enabled),
    );
    if (Object.keys(overrides).length) shops[shopId] = overrides;
  }

  return {
    snapshot: { schemaVersion: CONFIG_SNAPSHOT_SCHEMA_VERSION, version, company, shops },
    issues,
  };
}

/**
 * Checks one draft row on its own (module exists, config shape, shop-overridable
 * keys, always-enabled). Cross-module rules such as dependencies are checked at publish.
 */
export function validateDraftRow(row: DraftRow): ConfigIssue[] {
  if (!isModuleKey(row.moduleKey)) return [{ path: 'moduleKey', message: `Unknown module "${row.moduleKey}"` }];
  const mod = MODULE_REGISTRY[row.moduleKey];
  if (!isPlainObject(row.config)) return [{ path: 'config', message: 'Config must be an object' }];

  const issues: ConfigIssue[] = [];
  if (row.shopId !== null) {
    const allowed = new Set<string>(mod.shopOverridable);
    for (const key of Object.keys(row.config).filter((k) => !allowed.has(k))) {
      issues.push({ path: `config.${key}`, message: `"${key}" cannot be overridden per shop` });
    }
  }
  if (!issues.length) {
    const parsed = mod.configSchema.safeParse({ ...mod.defaults, ...row.config });
    if (!parsed.success) issues.push(...issuesFrom('config', parsed.error));
  }
  if (mod.alwaysEnabled && row.enabled === false) {
    issues.push({ path: 'enabled', message: `${mod.label} cannot be disabled` });
  }
  return issues;
}

function dependencyIssues(prefix: string, isEnabled: (key: ModuleKey) => boolean): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const key of MODULE_KEYS) {
    if (!isEnabled(key)) continue;
    for (const dep of MODULE_REGISTRY[key].dependsOn) {
      if (!isEnabled(dep)) {
        issues.push({
          path: `${prefix}.${key}.enabled`,
          message: `${MODULE_REGISTRY[key].label} requires ${MODULE_REGISTRY[dep].label} to be enabled`,
        });
      }
    }
  }
  return issues;
}

/** Draft rows that compile back to the given snapshot; used when rolling back. */
export function draftsFromSnapshot(snapshot: PublishedSnapshot): DraftRow[] {
  const rows: DraftRow[] = MODULE_KEYS.map((key) => ({
    shopId: null,
    moduleKey: key,
    enabled: snapshot.company[key].enabled,
    config: snapshot.company[key].config,
  }));
  for (const [shopId, overrides] of Object.entries(snapshot.shops)) {
    for (const [key, override] of Object.entries(overrides)) {
      if (!override) continue;
      rows.push({ shopId, moduleKey: key, enabled: override.enabled ?? null, config: override.config });
    }
  }
  return rows;
}

/** Structural diff; arrays are compared as whole values. */
export function diffJson(before: unknown, after: unknown, path = ''): ConfigChange[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (!isPlainObject(before) || !isPlainObject(after)) return [{ path, before, after }];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) => diffJson(before[key], after[key], path ? `${path}.${key}` : key));
}

/** Changes between two snapshots; `null` stands for "nothing published yet" (registry defaults). */
export function diffSnapshots(before: PublishedSnapshot | null, after: PublishedSnapshot): ConfigChange[] {
  const base = before ?? compileSnapshot([], new Set(), 0).snapshot;
  return diffJson({ company: base.company, shops: base.shops }, { company: after.company, shops: after.shops });
}
