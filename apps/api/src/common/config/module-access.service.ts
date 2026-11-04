import { ForbiddenException, Injectable } from '@nestjs/common';
import { TenantContext } from '../tenant/tenant-context';
import { ConfigResolverService } from './config-resolver.service';
import { MODULE_REGISTRY, ModuleKey } from './module-registry';
import { ModuleRegistryService } from './module-registry.service';

/**
 * Whether a company's business config has a module enabled (spec §9.1), for
 * callers that know the company but have no tenant context yet: guards, which
 * run before TenantRlsInterceptor, and public portals, which find the company
 * from a link token.
 *
 * Only the config layer is checked. Plan and permission limits stay with their
 * own guards and checks, so a company with no published config is unaffected.
 */
@Injectable()
export class ModuleAccessService {
  constructor(
    private readonly resolver: ConfigResolverService,
    private readonly registry: ModuleRegistryService,
  ) {}

  /** `companyId` must come from an authenticated user or a verified token, never from request input. */
  async isEnabled(companyId: string, shopId: string | null, key: ModuleKey): Promise<boolean> {
    const config = await TenantContext.run(
      { companyId, inRLSTx: false, systemAccess: false },
      async () => await this.resolver.resolve({ shopId }),
    );
    return this.registry.isEnabledInConfig(key, config);
  }

  async assertEnabled(companyId: string, shopId: string | null, key: ModuleKey): Promise<void> {
    if (!(await this.isEnabled(companyId, shopId, key))) {
      throw new ForbiddenException({
        code: 'MODULE_DISABLED',
        message: `${MODULE_REGISTRY[key].label} is not enabled for this organisation`,
        module: key,
      });
    }
  }
}
