import { SetMetadata } from '@nestjs/common';
import type { ModuleKey } from './module-registry';

export const REQUIRES_MODULE_KEY = 'requiresModule';

/**
 * Marks a controller (or a single handler) as part of a tenant module. When the
 * company's config disables that module, ModuleEnabledGuard refuses the request
 * with 403 MODULE_DISABLED. Named to avoid clashing with NestJS's `@Module`.
 */
export const RequiresModule = (key: ModuleKey) => SetMetadata(REQUIRES_MODULE_KEY, key);
