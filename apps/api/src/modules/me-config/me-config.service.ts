import { Injectable, NotFoundException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { createHash } from 'crypto';
import { ConfigResolverService, requireTenantCompanyId } from '../../common/config/config-resolver.service';
import {
  MODULE_KEYS,
  MODULE_REGISTRY,
  ModuleKey,
  ModuleSettings,
  SIDEBAR_SECTIONS,
  SidebarSectionId,
} from '../../common/config/module-registry';
import { ModuleRegistryService } from '../../common/config/module-registry.service';
import { UserPreferenceService } from '../../common/config/user-preference.service';
import type { UserPreferences } from '../../common/config/user-preference.schema';
import { planAllowsFeature } from '../../common/plans/plan-config';
import type { RequestUser } from '../../common/types/request-user';
import { PrismaService } from '../../prisma/prisma.service';

export type MeSidebarLink = {
  key: ModuleKey;
  label: string;
  path: string;
  icon: string;
  /** Plan does not include it: shown with a lock, as the web app does today. */
  locked: boolean;
};

/**
 * Why a module is not usable, first reason wins: the tenant's config turned it (or a
 * module it needs) off, the plan excludes it, it is org-admin only, or the user lacks
 * the permission. Lets the client show the right message: only `plan` gets an upgrade CTA.
 */
export type ModuleBlock = 'config' | 'plan' | 'role' | 'permission';

export type MeConfigResponse = {
  /** Published config version in effect; 0 = registry defaults. */
  version: number;
  modules: Record<ModuleKey, { usable: boolean; blockedBy: ModuleBlock | null; label: string; config: ModuleSettings }>;
  sidebar: { id: SidebarSectionId; title: string; children: MeSidebarLink[] }[];
  preferences: Record<string, UserPreferences>;
};

const ORG_ADMIN_ROLES: ReadonlySet<RoleName> = new Set([RoleName.OWNER, RoleName.ADMIN]);

@Injectable()
export class MeConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: ConfigResolverService,
    private readonly registry: ModuleRegistryService,
    private readonly preferences: UserPreferenceService,
  ) {}

  /** Everything the client needs to render for this user, plus a strong ETag over it. */
  async build(user: RequestUser): Promise<{ body: MeConfigResponse; etag: string }> {
    const companyId = requireTenantCompanyId();
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { subscriptionPlan: true },
    });
    if (!company) throw new NotFoundException('Company not found');

    const [config, preferences] = await Promise.all([
      this.resolver.resolve({ shopId: user.shopId }),
      this.preferences.get(user.id),
    ]);
    const permissions = new Set(user.permissions);
    const isOrgAdmin = ORG_ADMIN_ROLES.has(user.role);

    const modules = {} as MeConfigResponse['modules'];
    const visible = new Set<ModuleKey>();
    for (const key of MODULE_KEYS) {
      const mod = MODULE_REGISTRY[key];
      const resolved = config.modules[key];
      const roleAllows = !mod.requireOrgAdmin || isOrgAdmin;
      const enabled = resolved.enabled && mod.dependsOn.every((dep) => config.modules[dep].enabled);
      const usable = roleAllows && this.registry.isUsable(key, config, company.subscriptionPlan, permissions);
      const blockedBy: ModuleBlock | null = usable
        ? null
        : !enabled
          ? 'config'
          : mod.planGate && !planAllowsFeature(company.subscriptionPlan, mod.planGate)
            ? 'plan'
            : !roleAllows
              ? 'role'
              : 'permission';
      modules[key] = { usable, blockedBy, label: resolved.config.label ?? mod.label, config: resolved.config };
      // Same visibility rule as the web sidebar: org admins see every permission-gated
      // link, and plan-gated links stay visible but locked.
      const permitted = !mod.requiredPermission || isOrgAdmin || permissions.has(mod.requiredPermission);
      if (mod.inSidebar && enabled && roleAllows && permitted) visible.add(key);
    }

    const sidebar = SIDEBAR_SECTIONS.map(({ id, title }) => ({
      id,
      title,
      children: MODULE_KEYS.filter((key) => visible.has(key) && MODULE_REGISTRY[key].sidebarSection === id).map(
        (key): MeSidebarLink => {
          const mod = MODULE_REGISTRY[key];
          return {
            key,
            label: modules[key].label,
            path: mod.sidebarPath,
            icon: mod.sidebarIcon,
            locked: mod.planGate !== null && !planAllowsFeature(company.subscriptionPlan, mod.planGate),
          };
        },
      ),
    })).filter((section) => section.children.length > 0);

    const body: MeConfigResponse = { version: config.version, modules, sidebar, preferences };
    // Hash the whole payload: plan, role or permission changes alter it without a new version.
    const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`;
    return { body, etag };
  }

  setPreferences(user: RequestUser, scope: string, prefs: unknown): Promise<UserPreferences> {
    return this.preferences.set(user.id, scope, prefs);
  }
}
