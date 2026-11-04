import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionPlan } from '@prisma/client';
import { RequiresModule } from '../../../common/config/requires-module.decorator';
import type { SubscriptionService } from '../subscription.service';
import { PlanFeatureGuard } from './plan-feature.guard';

@RequiresModule('purchase-orders')
class PoController {
  write() {}
}
@RequiresModule('products')
class ProductsController {
  write() {}
}
class OpenController {
  write() {}
}

function ctx(cls: new () => object, method: string, companyId: string | null = 'c1', type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    getClass: () => cls,
    getHandler: () => (cls.prototype as Record<string, unknown>).write,
    switchToHttp: () => ({ getRequest: () => ({ method, user: companyId === undefined ? undefined : { companyId } }) }),
  } as unknown as ExecutionContext;
}

function setup(plan: SubscriptionPlan | null) {
  const subscriptions = { currentPlan: jest.fn().mockResolvedValue(plan) };
  return { guard: new PlanFeatureGuard(new Reflector(), subscriptions as unknown as SubscriptionService), subscriptions };
}

describe('PlanFeatureGuard', () => {
  it('refuses writes to a plan-gated module the plan does not include', async () => {
    const { guard } = setup(SubscriptionPlan.TRIAL);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const error = await guard.canActivate(ctx(PoController, method)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'PLAN_FEATURE_REQUIRED',
        feature: 'purchase_orders',
        module: 'purchase-orders',
      });
    }
  });

  it('lets reads through on any plan, so downgraded companies keep their documents', async () => {
    const { guard, subscriptions } = setup(SubscriptionPlan.TRIAL);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      await expect(guard.canActivate(ctx(PoController, method))).resolves.toBe(true);
    }
    expect(subscriptions.currentPlan).not.toHaveBeenCalled();
  });

  it('allows writes when the plan includes the feature', async () => {
    for (const plan of [SubscriptionPlan.PRO, SubscriptionPlan.PLUS]) {
      await expect(setup(plan).guard.canActivate(ctx(PoController, 'POST'))).resolves.toBe(true);
    }
  });

  it('ignores modules without a plan gate, untagged routes, users without a company and non-http contexts', async () => {
    const { guard, subscriptions } = setup(SubscriptionPlan.TRIAL);
    await expect(guard.canActivate(ctx(ProductsController, 'POST'))).resolves.toBe(true);
    await expect(guard.canActivate(ctx(OpenController, 'POST'))).resolves.toBe(true);
    await expect(guard.canActivate(ctx(PoController, 'POST', null))).resolves.toBe(true);
    await expect(guard.canActivate(ctx(PoController, 'POST', 'c1', 'rpc'))).resolves.toBe(true);
    expect(subscriptions.currentPlan).not.toHaveBeenCalled();
  });

  it('lets an unknown company through (other guards and services handle it)', async () => {
    await expect(setup(null).guard.canActivate(ctx(PoController, 'POST'))).resolves.toBe(true);
  });
});
