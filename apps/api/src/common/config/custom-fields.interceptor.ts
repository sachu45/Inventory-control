import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestUser } from '../types/request-user';
import { ConfigResolverService } from './config-resolver.service';
import {
  CUSTOM_FIELDS_FILTER_KEY,
  CUSTOM_FIELDS_PASSTHROUGH_KEY,
  CUSTOM_FIELDS_WRITE_KEY,
  CustomFieldValuesException,
  customFieldFilterIssues,
  redactCustomFields,
  resolveCustomFieldWrite,
} from './custom-field-values';
import { CUSTOM_FIELD_TABLES, type CustomFieldSnapshot } from './custom-fields';
import type { ModuleKey } from './module-registry';
import { REQUIRES_MODULE_KEY } from './requires-module.decorator';

/** The Prisma model holding each module's values, to read what a record already stores. */
const VALUE_MODELS: Partial<Record<ModuleKey, string>> = {
  products: 'product',
  suppliers: 'supplier',
  customers: 'customer',
  'purchase-orders': 'purchaseOrderHeader',
  'goods-receipts': 'goodsReceiptHeader',
  sales: 'salesOrderHeader',
  'goods-issues': 'goodsIssueHeader',
  invoices: 'invoiceHeader',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ValueReader = {
  findFirst(args: { where: Record<string, unknown>; select: { customFields: true } }): Promise<{ customFields: unknown } | null>;
};

/**
 * Enforces published custom fields (spec §4.5). Global, after TenantRlsInterceptor so the
 * tenant is set, and before validation pipes so it sees the raw body.
 *
 * Writes: checks submitted values, and replaces `body.customFields` with the full set to
 * store. Reads: every JSON response passes through {@link redactCustomFields}, so a field
 * restricted by `readRoles` cannot leak through a route that merely includes the record.
 */
@Injectable()
export class CustomFieldsInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: ConfigResolverService,
    private readonly prisma: PrismaService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(CUSTOM_FIELDS_PASSTHROUGH_KEY, targets)) return next.handle();

    const moduleKey = this.reflector.getAllAndOverride<ModuleKey | undefined>(REQUIRES_MODULE_KEY, targets);
    const req = context.switchToHttp().getRequest<{ user?: RequestUser; body?: unknown; params?: { id?: string }; query?: { cf?: unknown } }>();
    const user = req.user;
    const holdsValues = moduleKey !== undefined && CUSTOM_FIELD_TABLES[moduleKey] !== undefined;

    // No tenant user, or a route of no value-holding module: this response carries no custom fields.
    if (!user?.companyId || !holdsValues) {
      return next.handle().pipe(map((value) => redactCustomFields(value, null, '')));
    }

    const config = await this.resolver.resolve({ shopId: user.shopId ?? null });
    const fields: CustomFieldSnapshot[] = config.customFields[moduleKey] ?? [];

    const mode = this.reflector.get<'create' | 'update' | undefined>(CUSTOM_FIELDS_WRITE_KEY, context.getHandler());
    if (mode && typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)) {
      const body = req.body as Record<string, unknown>;
      const stored = mode === 'update' ? await this.storedValues(moduleKey, req.params?.id, user.companyId) : null;
      const { issues, values } = resolveCustomFieldWrite({ fields, role: user.role, submitted: body.customFields, stored, mode });
      if (issues.length) throw new CustomFieldValuesException(issues);
      if (values) body.customFields = values;
      else delete body.customFields;
    }

    const filter = req.query?.cf;
    if (filter !== undefined && this.reflector.get<boolean>(CUSTOM_FIELDS_FILTER_KEY, context.getHandler())) {
      const issues = customFieldFilterIssues(filter, fields, user.role);
      if (issues.length) throw new CustomFieldValuesException(issues);
    }

    return next.handle().pipe(map((value) => redactCustomFields(value, fields, user.role)));
  }

  /** A missing record reads as empty; the handler answers for it. */
  private async storedValues(moduleKey: ModuleKey, id: string | undefined, companyId: string): Promise<unknown> {
    if (!id || !UUID.test(id)) return null;
    const delegate = (this.prisma as unknown as Record<string, ValueReader>)[VALUE_MODELS[moduleKey] as string];
    // `products` has no RLS yet (#241); the other tables are scoped by RLS.
    const where = moduleKey === 'products' ? { id, companyId } : { id };
    const row = await delegate.findFirst({ where, select: { customFields: true } });
    return row?.customFields ?? null;
  }
}
