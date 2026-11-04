import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import type { RequestUser } from '../types/request-user';
import { ConfigResolverService } from './config-resolver.service';
import type { ModuleKey } from './module-registry';
import { MandatoryFieldsException, applyWritePolicy, fieldPolicy, redactHidden } from './module-fields';

export const MODULE_FIELDS_KEY = 'moduleFields';
export const MODULE_FIELDS_WRITE_KEY = 'moduleFieldsWrite';

/**
 * Applies the company's field config for `key` to a controller (spec §9.2):
 * hidden fields are removed from every JSON response. Pair with
 * `@ModuleFieldsWrite` on create/update handlers.
 */
export const ModuleFields = (key: ModuleKey) => SetMetadata(MODULE_FIELDS_KEY, key);

/** On this handler, also drop hidden fields from the body and require configured mandatory fields (422). */
export const ModuleFieldsWrite = (mode: 'create' | 'update') => SetMetadata(MODULE_FIELDS_WRITE_KEY, mode);

/**
 * Global, registered after TenantRlsInterceptor so the tenant context exists.
 * It runs before validation pipes, so it sees the raw body: a hidden field is
 * removed before validation, and a missing mandatory field fails with 422.
 */
@Injectable()
export class ModuleFieldsInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: ConfigResolverService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const key = this.reflector.getAllAndOverride<ModuleKey | undefined>(MODULE_FIELDS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!key) return next.handle();
    const req = context.switchToHttp().getRequest<{ user?: RequestUser; body?: unknown }>();
    if (!req.user?.companyId) return next.handle();

    const config = await this.resolver.resolve({ shopId: req.user.shopId ?? null });
    const policy = fieldPolicy(key, config);

    const mode = this.reflector.get<'create' | 'update' | undefined>(MODULE_FIELDS_WRITE_KEY, context.getHandler());
    if (mode && typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)) {
      const issues = applyWritePolicy(key, policy, req.body as Record<string, unknown>, mode);
      if (issues.length) throw new MandatoryFieldsException(issues);
    }

    if (!policy.hidden.length) return next.handle();
    return next.handle().pipe(map((value) => redactHidden(key, policy, value)));
  }
}
