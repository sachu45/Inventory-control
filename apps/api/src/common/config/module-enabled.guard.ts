import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestUser } from '../types/request-user';
import { ModuleAccessService } from './module-access.service';
import type { ModuleKey } from './module-registry';
import { REQUIRES_MODULE_KEY } from './requires-module.decorator';

/**
 * Refuses requests to a module the company's business config has disabled
 * (spec §9.1). Hiding a module in the sidebar is not enough; its API must refuse too.
 *
 * Runs after SubscriptionWriteGuard. Guards run before TenantRlsInterceptor, so
 * there is no TenantContext yet: the company comes from the authenticated
 * `request.user`, the same source the interceptor uses.
 *
 * Public portals have no `request.user`; their services check the module with
 * the company their link token belongs to.
 */
@Injectable()
export class ModuleEnabledGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: ModuleAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const key = this.reflector.getAllAndOverride<ModuleKey | undefined>(REQUIRES_MODULE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!key) return true;

    const user = context.switchToHttp().getRequest<{ user?: RequestUser }>().user;
    // Public routes and platform-wide users have no tenant config to apply.
    if (!user?.companyId) return true;

    await this.access.assertEnabled(user.companyId, user.shopId ?? null, key);
    return true;
  }
}
