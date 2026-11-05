import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { auditRequestMetadata } from '../../common/utils/audit-context';
import { AuditService } from '../audit/audit.service';

export type PlatformAuditAction =
  | 'platform_dashboard_view'
  | 'platform_subscription_backfill'
  | 'platform_notification_read'
  | 'platform_notification_read_all'
  | 'platform_health_view'
  | 'platform_config_draft_set'
  | 'platform_config_draft_reset'
  | 'platform_config_publish'
  | 'platform_config_rollback'
  | 'platform_feature_flag_set';

@Injectable()
export class PlatformAuditService {
  constructor(private readonly audit: AuditService) {}

  async logPlatformAction(args: {
    userId: string;
    adminEmail: string;
    /** Tenant the action was taken on, so it shows in that company's audit trail. */
    companyId?: string | null;
    oldValues?: Record<string, unknown>;
    action: PlatformAuditAction;
    entityType?: string;
    entityId?: string;
    recordCode?: string;
    auditAction?: AuditAction;
    extra?: Record<string, unknown>;
  }) {
    const meta = auditRequestMetadata();
    await this.audit.log({
      userId: args.userId,
      companyId: args.companyId ?? null,
      action: args.auditAction ?? AuditAction.EXPORT_AUDIT,
      entityType: args.entityType ?? 'PlatformAdmin',
      entityId: args.entityId ?? args.userId,
      ...(args.oldValues ? { oldValues: args.oldValues as Prisma.InputJsonValue } : {}),
      newValues: {
        platformAction: args.action,
        adminEmail: args.adminEmail,
        recordCode: args.recordCode ?? null,
        ...args.extra,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }
}
