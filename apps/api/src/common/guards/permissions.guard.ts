import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleName } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PERMISSIONS_ANY_KEY } from '../decorators/require-any-permission.decorator';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';
import type { RequestUser } from '../types/request-user';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredAny = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_ANY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest();
    const user = request.user as RequestUser | undefined;
    if (!required?.length && !requiredAny?.length) {
      if (user) this.assertShopScope(request, user);
      return true;
    }

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // Build a Set once per request so all permission lookups are O(1).
    const permSet = new Set(user.permissions);
    const hasWildcard = permSet.has('*');

    if (requiredAny?.length) {
      const allowed = hasWildcard || requiredAny.some((perm) => permSet.has(perm));
      if (!allowed) {
        throw new ForbiddenException('Missing permission');
      }
    } else if (required?.length) {
      if (!hasWildcard) {
        for (const perm of required) {
          if (!permSet.has(perm)) {
            throw new ForbiddenException('Missing permission');
          }
        }
      }
    }

    this.assertShopScope(request, user);
    return true;
  }

  /** A shop-scoped role may not name another shop, whatever the route declares. */
  private assertShopScope(
    request: { params?: Record<string, unknown>; body?: Record<string, unknown>; query?: Record<string, unknown> },
    user: RequestUser,
  ): void {
    const shopIdParam =
      request.params?.shopId ??
      request.params?.shop_id ??
      request.body?.shopId ??
      request.body?.shop_id ??
      request.query?.shop_id ??
      request.query?.shopId;

    if (
      (user.role === RoleName.SHOP_USER ||
        user.role === RoleName.WAREHOUSE_STAFF ||
        user.role === RoleName.EMPLOYEE ||
        user.role === RoleName.SALES ||
        user.role === RoleName.VIEWER ||
        user.role === RoleName.VENDOR) &&
      shopIdParam &&
      user.shopId &&
      shopIdParam !== user.shopId
    ) {
      throw new ForbiddenException('Shop scope mismatch');
    }
  }
}
