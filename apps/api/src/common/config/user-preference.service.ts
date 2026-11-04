import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigResolverService, requireTenantCompanyId } from './config-resolver.service';
import { isModuleKey } from './module-registry';
import { InvalidPreferencesException, UserPreferences, parseUserPreferences } from './user-preference.schema';

export const SIDEBAR_PREFERENCE_SCOPE = 'sidebar';

/** A user's own UI preferences, always for the company of the current request. */
@Injectable()
export class UserPreferenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: ConfigResolverService,
  ) {}

  get(userId: string): Promise<Record<string, UserPreferences>> {
    return this.resolver.resolvePreferences(userId);
  }

  async set(userId: string, scope: string, input: unknown): Promise<UserPreferences> {
    const companyId = requireTenantCompanyId();
    if (scope !== SIDEBAR_PREFERENCE_SCOPE && !isModuleKey(scope)) {
      throw new InvalidPreferencesException([{ path: 'scope', message: `Unknown preference scope "${scope}"` }]);
    }
    const prefs = parseUserPreferences(input);
    await this.prisma.userPreference.upsert({
      where: { companyId_userId_scope: { companyId, userId, scope } },
      create: { companyId, userId, scope, prefs: prefs as Prisma.InputJsonValue },
      update: { prefs: prefs as Prisma.InputJsonValue },
    });
    await this.resolver.invalidatePreferences(companyId, userId);
    return prefs;
  }
}
