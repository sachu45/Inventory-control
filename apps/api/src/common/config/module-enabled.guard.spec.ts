import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestUser } from '../types/request-user';
import { TenantContext } from '../tenant/tenant-context';
import { compileSnapshot } from './config-snapshot';
import type { ConfigResolverService, ResolvedConfig } from './config-resolver.service';
import { ModuleAccessService } from './module-access.service';
import { ModuleEnabledGuard } from './module-enabled.guard';
import { ModuleKey } from './module-registry';
import { ModuleRegistryService } from './module-registry.service';
import { RequiresModule } from './requires-module.decorator';

@RequiresModule('purchase-orders')
class PurchaseOrdersController {
  list() {}
  @RequiresModule('reports')
  report() {}
}

class OpenController {
  list() {}
}

function resolved(disabled: ModuleKey[] = []): ResolvedConfig {
  const modules = structuredClone(compileSnapshot([], new Set(), 1).snapshot.company);
  for (const key of disabled) modules[key].enabled = false;
  return { companyId: 'c1', version: 1, shopId: null, modules } as ResolvedConfig;
}

function ctx(cls: new () => object, handler: string, user?: Partial<RequestUser>, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    getClass: () => cls,
    getHandler: () => (cls.prototype as Record<string, unknown>)[handler],
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function setup(config: ResolvedConfig = resolved()) {
  const seen: { companyId?: string | null; shopId?: string | null }[] = [];
  const resolver = {
    resolve: jest.fn(async (options: { shopId?: string | null }) => {
      seen.push({ companyId: TenantContext.get()?.companyId, shopId: options.shopId });
      return config;
    }),
  };
  const guard = new ModuleEnabledGuard(
    new Reflector(),
    new ModuleAccessService(resolver as unknown as ConfigResolverService, new ModuleRegistryService()),
  );
  return { guard, resolver, seen };
}

const tenantUser = { id: 'u1', companyId: 'c1', shopId: 's1' };

describe('ModuleEnabledGuard', () => {
  it('allows an enabled module, resolving config for the user company and shop', async () => {
    const { guard, seen } = setup();
    await expect(guard.canActivate(ctx(PurchaseOrdersController, 'list', tenantUser))).resolves.toBe(true);
    expect(seen).toEqual([{ companyId: 'c1', shopId: 's1' }]);
  });

  it('refuses a disabled module with 403 MODULE_DISABLED', async () => {
    const { guard } = setup(resolved(['purchase-orders']));
    const error = await guard.canActivate(ctx(PurchaseOrdersController, 'list', tenantUser)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'MODULE_DISABLED', module: 'purchase-orders' });
  });

  it('refuses a module whose dependency is disabled', async () => {
    const { guard } = setup(resolved(['suppliers']));
    await expect(guard.canActivate(ctx(PurchaseOrdersController, 'list', tenantUser))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lets a handler-level module override the controller module', async () => {
    const { guard } = setup(resolved(['purchase-orders']));
    await expect(guard.canActivate(ctx(PurchaseOrdersController, 'report', tenantUser))).resolves.toBe(true);
  });

  it('ignores routes without @RequiresModule, users without a company and non-http contexts', async () => {
    const { guard, resolver } = setup(resolved(['purchase-orders']));
    await expect(guard.canActivate(ctx(OpenController, 'list', tenantUser))).resolves.toBe(true);
    await expect(guard.canActivate(ctx(PurchaseOrdersController, 'list', undefined))).resolves.toBe(true);
    await expect(guard.canActivate(ctx(PurchaseOrdersController, 'list', { id: 'p', companyId: null }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx(PurchaseOrdersController, 'list', tenantUser, 'rpc'))).resolves.toBe(true);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('does not apply plan or permission limits (other guards own those)', async () => {
    const { guard } = setup();
    // A user with no permissions on any plan: only config is checked here.
    await expect(
      guard.canActivate(ctx(PurchaseOrdersController, 'list', { ...tenantUser, permissions: [] })),
    ).resolves.toBe(true);
  });
});
