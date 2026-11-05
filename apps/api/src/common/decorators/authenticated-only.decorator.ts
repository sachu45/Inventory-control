import { SetMetadata } from '@nestjs/common';

export const AUTHENTICATED_ONLY_KEY = 'authenticatedOnly';

/**
 * Marks a route as deliberately open to any signed-in user of the company: it acts on
 * the caller's own data, or its service authorises per record (e.g. only the assignee
 * may approve). The reason is required so a route-table review can see why.
 */
export const AuthenticatedOnly = (reason: string) => SetMetadata(AUTHENTICATED_ONLY_KEY, reason);
