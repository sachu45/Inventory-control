import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MODULE_REGISTRY, type ModuleKey } from '../../../common/config/module-registry';
import { REQUIRES_MODULE_KEY } from '../../../common/config/requires-module.decorator';
import { planAllowsFeature } from '../../../common/plans/plan-config';
import type { RequestUser } from '../../../common/types/request-user';
import { SubscriptionService } from '../subscription.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Plan gating for every write route of a plan-gated module (#240). The module
 * comes from the route's @RequiresModule tag and its plan feature from the
 * module registry (`planGate`), so a new route in a gated module is covered
 * without its service remembering to call assertFeature.
 *
 * Reads are left to the services, so a company that downgrades can still open
 * the documents it created on a higher plan. Runs after SubscriptionWriteGuard,
 * which handles expired subscriptions; this guard only checks the plan tier.
 */
@Injectable()
export class PlanFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptions: SubscriptionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<{ method: string; user?: RequestUser }>();
    if (READ_METHODS.has(req.method)) return true;
    const key = this.reflector.getAllAndOverride<ModuleKey | undefined>(REQUIRES_MODULE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const feature = key ? MODULE_REGISTRY[key].planGate : null;
    if (!key || !feature) return true;
    // Public routes and platform-wide users have no tenant plan to apply.
    const companyId = req.user?.companyId;
    if (!companyId) return true;

    const plan = await this.subscriptions.currentPlan(companyId);
    if (plan && !planAllowsFeature(plan, feature)) {
      throw new ForbiddenException({
        code: 'PLAN_FEATURE_REQUIRED',
        message: `${MODULE_REGISTRY[key].label} requires a paid plan. Upgrade from Settings → Upgrade.`,
        feature,
        module: key,
      });
    }
    return true;
  }
}
