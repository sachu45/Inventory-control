import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../cache/redis.provider';
import { MetricsService } from '../observability/metrics.service';
import { TenantContext } from '../tenant/tenant-context';
import {
  CONFIG_SNAPSHOT_SCHEMA_VERSION,
  PublishedSnapshot,
  compileSnapshot,
  latestVersionCacheKey,
} from './config-snapshot';
import { MODULE_KEYS, MODULE_REGISTRY, ModuleKey, ModuleSettings } from './module-registry';
import { UserPreferences, applyMandatoryColumns, parseUserPreferences } from './user-preference.schema';

export const LATEST_TTL_SECONDS = 5;
export const SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;
export const PREFERENCES_TTL_SECONDS = 5 * 60;
const LOCAL_SNAPSHOT_LIMIT = 1000;
const LOCAL_PREFERENCES_LIMIT = 5000;

export type ConfigLayer = 'registry' | 'company' | 'shop';
export type ResolvedModule = { enabled: boolean; config: ModuleSettings };
export type ResolvedConfig = {
  companyId: string;
  /** Published version in effect; 0 means nothing published yet (registry defaults). */
  version: number;
  shopId: string | null;
  modules: Record<ModuleKey, ResolvedModule>;
  /** Present with `explain: true`: the layer that set each `module.enabled` / `module.config.key`. */
  provenance?: Record<string, ConfigLayer>;
};

export function snapshotCacheKey(companyId: string, version: number): string {
  return `cfg:v1:${companyId}:snap:${version}`;
}

export function preferencesCacheKey(companyId: string, userId: string): string {
  return `cfg:v1:pref:${companyId}:${userId}`;
}

type RedisLike = Pick<Redis, 'get' | 'set' | 'del'>;
type Expiring<T> = { value: T; expiresAt: number };

/** Insertion-ordered Map with a size cap; reads refresh recency. */
class LruMap<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string);
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

const DEFAULT_SNAPSHOT = compileSnapshot([], new Set(), 0).snapshot;

/**
 * Reads the business config a tenant request runs under. Read path per key:
 * in-process cache -> Redis -> Postgres, with one in-flight load per key.
 * Snapshots are immutable, so only the "latest version" pointer can go stale (5s).
 */
@Injectable()
export class ConfigResolverService {
  private readonly latest = new LruMap<Expiring<number>>(LOCAL_SNAPSHOT_LIMIT);
  private readonly snapshots = new LruMap<PublishedSnapshot>(LOCAL_SNAPSHOT_LIMIT);
  private readonly preferences = new LruMap<Expiring<Record<string, UserPreferences>>>(LOCAL_PREFERENCES_LIMIT);
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisLike,
    private readonly metrics: MetricsService,
  ) {}

  async resolve(options: { shopId?: string | null; explain?: boolean } = {}): Promise<ResolvedConfig> {
    const companyId = this.currentCompanyId();
    const version = await this.latestVersion(companyId);
    const snapshot = version === 0 ? DEFAULT_SNAPSHOT : await this.snapshot(companyId, version);
    return materialize(companyId, snapshot, options.shopId ?? null, options.explain ?? false);
  }

  /**
   * The user's preferences by scope, with hidden columns that the business config
   * makes mandatory removed, so a preference can never hide a required field.
   */
  async resolvePreferences(userId: string): Promise<Record<string, UserPreferences>> {
    const companyId = this.currentCompanyId();
    const [stored, config] = await Promise.all([this.storedPreferences(companyId, userId), this.resolve()]);
    const result: Record<string, UserPreferences> = {};
    for (const [scope, prefs] of Object.entries(stored)) {
      const mod = MODULE_REGISTRY[scope as ModuleKey];
      result[scope] = mod
        ? applyMandatoryColumns(prefs, new Set([...mod.lockedMandatoryFields, ...config.modules[mod.key].config.mandatoryFields]))
        : prefs;
    }
    return result;
  }

  /** Drop this process's latest-version pointer, e.g. right after publishing on this node. */
  invalidateLatest(companyId: string): void {
    this.latest.delete(latestVersionCacheKey(companyId));
  }

  /** Call after writing a user's preferences. */
  async invalidatePreferences(companyId: string, userId: string): Promise<void> {
    const key = preferencesCacheKey(companyId, userId);
    this.preferences.delete(key);
    await this.redisCall('del', () => this.redis.del(key));
  }

  private currentCompanyId(): string {
    const companyId = TenantContext.get()?.companyId;
    if (!companyId) throw new ForbiddenException('Config can only be resolved inside a tenant context');
    return companyId;
  }

  private async latestVersion(companyId: string): Promise<number> {
    const key = latestVersionCacheKey(companyId);
    const local = this.latest.get(key);
    if (local && local.expiresAt > Date.now()) return local.value;

    return this.singleFlight(key, async () => {
      const cached = await this.redisCall('get', () => this.redis.get(key));
      let version = cached === null || cached === undefined ? NaN : Number(cached);
      if (!Number.isInteger(version) || version < 0) {
        const row = await this.prisma.configVersion.findFirst({
          where: { companyId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        version = row?.version ?? 0;
        await this.redisCall('set', () => this.redis.set(key, String(version), 'EX', LATEST_TTL_SECONDS));
      }
      this.latest.set(key, { value: version, expiresAt: Date.now() + LATEST_TTL_SECONDS * 1000 });
      return version;
    });
  }

  private async snapshot(companyId: string, version: number): Promise<PublishedSnapshot> {
    const key = snapshotCacheKey(companyId, version);
    const local = this.snapshots.get(key);
    if (local) return local;

    return this.singleFlight(key, async () => {
      const cached = await this.redisCall('get', () => this.redis.get(key));
      let snapshot = cached ? parseSnapshot(cached) : null;
      if (!snapshot) {
        const row = await this.prisma.configVersion.findUnique({
          where: { companyId_version: { companyId, version } },
          select: { snapshot: true, schemaVersion: true },
        });
        if (!row) throw new Error(`Config version ${version} for company ${companyId} is missing`);
        snapshot = upgradeSnapshot(row.snapshot as unknown as PublishedSnapshot);
        await this.redisCall('set', () =>
          this.redis.set(key, JSON.stringify(snapshot), 'EX', SNAPSHOT_TTL_SECONDS),
        );
      }
      this.snapshots.set(key, snapshot);
      return snapshot;
    });
  }

  private async storedPreferences(companyId: string, userId: string): Promise<Record<string, UserPreferences>> {
    const key = preferencesCacheKey(companyId, userId);
    const local = this.preferences.get(key);
    if (local && local.expiresAt > Date.now()) return local.value;

    return this.singleFlight(key, async () => {
      const cached = await this.redisCall('get', () => this.redis.get(key));
      let value = cached ? (JSON.parse(cached) as Record<string, UserPreferences>) : null;
      if (!value) {
        const rows = await this.prisma.userPreference.findMany({
          where: { companyId, userId },
          select: { scope: true, prefs: true },
        });
        // Rows are validated on write; re-parse so a bad row can never reach the UI.
        value = Object.fromEntries(rows.map((row) => [row.scope, parseUserPreferences(row.prefs)]));
        await this.redisCall('set', () =>
          this.redis.set(key, JSON.stringify(value), 'EX', PREFERENCES_TTL_SECONDS),
        );
      }
      this.preferences.set(key, { value, expiresAt: Date.now() + PREFERENCES_TTL_SECONDS * 1000 });
      return value;
    });
  }

  private singleFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;
    const promise = load().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  /** Redis is a cache: on failure, count it and carry on to Postgres. */
  private async redisCall<T>(op: string, call: () => Promise<T>): Promise<T | null> {
    try {
      return await call();
    } catch {
      this.metrics.configCacheRedisErrors.inc({ op });
      return null;
    }
  }
}

function parseSnapshot(raw: string): PublishedSnapshot | null {
  try {
    return upgradeSnapshot(JSON.parse(raw) as PublishedSnapshot);
  } catch {
    return null;
  }
}

/** Upgrades older snapshot formats in memory (spec §4.6); there is only v1 today. */
function upgradeSnapshot(snapshot: PublishedSnapshot): PublishedSnapshot {
  if (snapshot.schemaVersion !== CONFIG_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Unsupported config snapshot schemaVersion ${String(snapshot.schemaVersion)}`);
  }
  return snapshot;
}

function materialize(
  companyId: string,
  snapshot: PublishedSnapshot,
  shopId: string | null,
  explain: boolean,
): ResolvedConfig {
  const shopOverrides = shopId ? snapshot.shops[shopId] ?? {} : {};
  const modules = {} as Record<ModuleKey, ResolvedModule>;
  const provenance: Record<string, ConfigLayer> = {};

  for (const key of MODULE_KEYS) {
    const mod = MODULE_REGISTRY[key];
    const company = snapshot.company[key] ?? { enabled: mod.defaultEnabled, config: mod.defaults };
    const override = shopOverrides[key];
    const config: ModuleSettings = { ...company.config };
    const allowed = new Set<string>(mod.shopOverridable);
    const shopKeys = new Set<string>();
    for (const [field, value] of Object.entries(override?.config ?? {})) {
      if (!allowed.has(field)) continue;
      (config as Record<string, unknown>)[field] = value;
      shopKeys.add(field);
    }
    const enabled = mod.alwaysEnabled || (override?.enabled ?? company.enabled);
    modules[key] = { enabled, config };

    if (!explain) continue;
    provenance[`${key}.enabled`] =
      override?.enabled !== undefined ? 'shop' : company.enabled !== mod.defaultEnabled ? 'company' : 'registry';
    const defaults = mod.defaults as Record<string, unknown>;
    for (const field of new Set([...Object.keys(defaults), ...Object.keys(config)])) {
      provenance[`${key}.config.${field}`] = shopKeys.has(field)
        ? 'shop'
        : JSON.stringify((company.config as Record<string, unknown>)[field]) !== JSON.stringify(defaults[field])
          ? 'company'
          : 'registry';
    }
  }

  return {
    companyId,
    version: snapshot.version,
    shopId,
    modules,
    ...(explain ? { provenance } : {}),
  };
}
