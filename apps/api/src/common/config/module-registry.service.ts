import { Injectable } from '@nestjs/common';
import { SubscriptionPlan } from '@prisma/client';
import { planAllowsFeature } from '../plans/plan-config';
import type { ResolvedConfig } from './config-resolver.service';
import { MODULE_KEYS, MODULE_REGISTRY, ModuleDefinition, ModuleKey, isModuleKey } from './module-registry';

@Injectable()
export class ModuleRegistryService {
  all(): readonly ModuleDefinition[] {
    return MODULE_KEYS.map((key) => MODULE_REGISTRY[key]);
  }

  get(key: string): ModuleDefinition | undefined {
    return isModuleKey(key) ? MODULE_REGISTRY[key] : undefined;
  }

  /**
   * Config can only narrow what the plan and permissions already allow; it never grants
   * access. Org-admin-only modules (`requireOrgAdmin`) are gated separately by the caller.
   */
  isUsable(
    key: ModuleKey,
    config: Pick<ResolvedConfig, 'modules'>,
    plan: SubscriptionPlan,
    permissions: ReadonlySet<string>,
  ): boolean {
    const mod = MODULE_REGISTRY[key];
    return (
      this.isEnabledInConfig(key, config) &&
      (mod.planGate === null || planAllowsFeature(plan, mod.planGate)) &&
      (mod.requiredPermission === null || permissions.has(mod.requiredPermission))
    );
  }

  /** The config layer of `isUsable`: the module and the modules it depends on are enabled. */
  isEnabledInConfig(key: ModuleKey, config: Pick<ResolvedConfig, 'modules'>): boolean {
    return (
      config.modules[key].enabled &&
      MODULE_REGISTRY[key].dependsOn.every((dep) => config.modules[dep].enabled)
    );
  }

  usableModules(
    config: Pick<ResolvedConfig, 'modules'>,
    plan: SubscriptionPlan,
    permissions: ReadonlySet<string>,
  ): ModuleKey[] {
    return MODULE_KEYS.filter((key) => this.isUsable(key, config, plan, permissions));
  }
}
