import { Injectable, NotFoundException } from '@nestjs/common';
import { FeatureFlagsService, type WorkflowFeature } from '../../common/workflow-engine/ops/feature-flags.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import type { RequestUser } from '../../common/types/request-user';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformAuditService } from '../platform/platform-audit.service';

/** Platform-admin reads and writes of a tenant's workflow feature flags (#243). */
@Injectable()
export class PlatformFeatureFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
    private readonly platformAudit: PlatformAuditService,
  ) {}

  list(companyId: string) {
    return this.inTenant(companyId, () => this.flags.list(companyId));
  }

  set(companyId: string, feature: WorkflowFeature, enabled: boolean, actor: RequestUser) {
    return this.inTenant(companyId, async () => {
      const result = await this.flags.setEnabled(companyId, feature, enabled);
      await this.platformAudit.logPlatformAction({
        userId: actor.id,
        adminEmail: actor.email,
        companyId,
        action: 'platform_feature_flag_set',
        entityType: 'FeatureFlag',
        entityId: companyId,
        recordCode: feature,
        oldValues: { enabled: result.previous },
        extra: { feature, enabled },
      });
      return result;
    });
  }

  /** Runs `work` as the target company, so RLS scopes every query to it. */
  private inTenant<T>(companyId: string, work: () => Promise<T>): Promise<T> {
    return TenantContext.run({ companyId, inRLSTx: false, systemAccess: false }, async () => {
      const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!company) throw new NotFoundException('Company not found');
      return work();
    });
  }
}
