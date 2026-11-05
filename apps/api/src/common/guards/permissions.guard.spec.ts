import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleName } from '@prisma/client';
import { Public } from '../decorators/public.decorator';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { PermissionsGuard } from './permissions.guard';

class Routes {
  undeclared() {}
  @RequirePermission('stock:read')
  declared() {}
  @Public()
  open() {}
}

type Req = { user?: unknown; params?: object; body?: object; query?: object };

function context(handler: keyof Routes, req: Req): ExecutionContext {
  return {
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const shopUser = { id: 'u1', role: RoleName.SHOP_USER, shopId: 'shop-a', permissions: ['stock:read'] };
const owner = { id: 'u2', role: RoleName.OWNER, shopId: null, permissions: ['*'] };

describe('PermissionsGuard', () => {
  const guard = new PermissionsGuard(new Reflector());

  describe.each(['undeclared', 'declared'] as const)('shop scope on a route that is %s', (handler) => {
    it.each([
      ['params', { params: { shopId: 'shop-b' } }],
      ['body', { body: { shopId: 'shop-b' } }],
      ['query', { query: { shop_id: 'shop-b' } }],
    ])('refuses a shop-scoped role naming another shop in %s', (_where, req) => {
      expect(() => guard.canActivate(context(handler, { user: shopUser, ...req }))).toThrow(
        new ForbiddenException('Shop scope mismatch'),
      );
    });

    it('allows the user\'s own shop and requests naming no shop', () => {
      expect(guard.canActivate(context(handler, { user: shopUser, params: { shopId: 'shop-a' } }))).toBe(true);
      expect(guard.canActivate(context(handler, { user: shopUser }))).toBe(true);
    });

    it('does not limit company-wide roles', () => {
      expect(guard.canActivate(context(handler, { user: owner, params: { shopId: 'shop-b' } }))).toBe(true);
    });
  });

  it('still requires declared permissions', () => {
    const noPerms = { ...shopUser, permissions: [] };
    expect(() => guard.canActivate(context('declared', { user: noPerms }))).toThrow(new ForbiddenException('Missing permission'));
    expect(() => guard.canActivate(context('declared', {}))).toThrow(new ForbiddenException('Authentication required'));
  });

  it('skips public routes and undeclared routes with no user', () => {
    expect(guard.canActivate(context('open', { params: { shopId: 'shop-b' } }))).toBe(true);
    expect(guard.canActivate(context('undeclared', { params: { shopId: 'shop-b' } }))).toBe(true);
  });
});
