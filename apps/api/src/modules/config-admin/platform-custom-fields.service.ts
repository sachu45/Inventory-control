import { Injectable, NotFoundException } from '@nestjs/common';
import type { CustomFieldDefinition } from '@prisma/client';
import { CustomFieldService } from '../../common/config/custom-field.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import type { RequestUser } from '../../common/types/request-user';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformAuditService } from '../platform/platform-audit.service';

/** Platform-admin edits to a tenant's draft custom fields (#167). Each write is audited. */
@Injectable()
export class PlatformCustomFieldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fields: CustomFieldService,
    private readonly platformAudit: PlatformAuditService,
  ) {}

  list(companyId: string, moduleKey?: string) {
    return this.inTenant(companyId, () => this.fields.list(companyId, moduleKey));
  }

  create(companyId: string, body: unknown, actor: RequestUser) {
    return this.inTenant(companyId, async () => {
      const row = await this.fields.create(companyId, body);
      await this.audit(actor, companyId, row, null);
      return row;
    });
  }

  update(companyId: string, id: string, body: unknown, actor: RequestUser) {
    return this.inTenant(companyId, async () => {
      const { before, after } = await this.fields.update(companyId, id, body);
      await this.audit(actor, companyId, after, before);
      return after;
    });
  }

  setArchived(companyId: string, id: string, archived: boolean, actor: RequestUser) {
    return this.inTenant(companyId, async () => {
      const row = await this.fields.setArchived(companyId, id, archived);
      await this.audit(actor, companyId, row, null);
      return row;
    });
  }

  private audit(actor: RequestUser, companyId: string, after: CustomFieldDefinition, before: CustomFieldDefinition | null) {
    return this.platformAudit.logPlatformAction({
      userId: actor.id,
      adminEmail: actor.email,
      companyId,
      action: 'platform_custom_field_set',
      entityType: 'CustomFieldDefinition',
      entityId: after.id,
      recordCode: `${after.moduleKey}.${after.fieldKey}`,
      oldValues: { value: before },
      extra: { after },
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
