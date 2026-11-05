import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CustomFieldDefinition, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigValidationException } from './config-snapshot';
import {
  CUSTOM_FIELD_TABLES,
  createCustomFieldSchema,
  customFieldIssues,
  removedOptionValues,
  updateCustomFieldSchema,
} from './custom-fields';
import type { ModuleKey } from './module-registry';

type Raw = Pick<Prisma.TransactionClient, '$queryRawUnsafe'>;

/** Whether any record of the company holds a value for this field. */
export async function customFieldHasValues(db: Raw, companyId: string, moduleKey: string, fieldKey: string): Promise<boolean> {
  const table = CUSTOM_FIELD_TABLES[moduleKey as ModuleKey];
  if (!table) return false;
  // `products` has no RLS yet (#241), so it filters explicitly; the others are scoped by RLS.
  const tenantFilter = table === 'products' ? 'AND company_id = $2::uuid' : '';
  const params = table === 'products' ? [fieldKey, companyId] : [fieldKey];
  const rows = await db.$queryRawUnsafe<{ found: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM "${table}" WHERE jsonb_exists(custom_fields, $1) ${tenantFilter}) AS found`,
    ...params,
  );
  return rows[0]?.found === true;
}

function parsed<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new ConfigValidationException(
    result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  );
}

const jsonOrNull = (value: unknown) => (value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue));

/**
 * Admin edits to custom field definitions, enforcing the lifecycle rules of spec §4.5.
 * Like other drafts, nothing here changes live config until ConfigPublishService publishes.
 */
@Injectable()
export class CustomFieldService {
  constructor(private readonly prisma: PrismaService) {}

  list(companyId: string, moduleKey?: string): Promise<CustomFieldDefinition[]> {
    return this.prisma.customFieldDefinition.findMany({
      where: { companyId, ...(moduleKey ? { moduleKey } : {}) },
      orderBy: [{ moduleKey: 'asc' }, { sortOrder: 'asc' }, { fieldKey: 'asc' }],
    });
  }

  async create(companyId: string, body: unknown): Promise<CustomFieldDefinition> {
    const input = parsed(createCustomFieldSchema.safeParse(body));
    this.assertValid(input);
    try {
      return await this.prisma.customFieldDefinition.create({
        data: {
          companyId,
          moduleKey: input.moduleKey,
          fieldKey: input.fieldKey,
          label: input.label,
          fieldType: input.fieldType,
          options: jsonOrNull(input.options ?? null),
          validation: jsonOrNull(input.validation ?? null),
          required: input.required ?? false,
          defaultValue: jsonOrNull(input.defaultValue ?? null),
          searchable: input.searchable ?? false,
          readRoles: input.readRoles ?? [],
          writeRoles: input.writeRoles ?? [],
          sortOrder: input.sortOrder ?? 0,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          message: `Field "${input.fieldKey}" already exists in this module; archived fields can be restored`,
          code: 'CUSTOM_FIELD_EXISTS',
        });
      }
      throw err;
    }
  }

  async update(companyId: string, id: string, body: unknown): Promise<{ before: CustomFieldDefinition; after: CustomFieldDefinition }> {
    const existing = await this.findOwned(companyId, id);
    if (existing.archivedAt) {
      throw new ConflictException({ message: 'Restore this field before editing it', code: 'CUSTOM_FIELD_ARCHIVED' });
    }
    if (typeof body === 'object' && body !== null) {
      for (const key of ['fieldKey', 'moduleKey'] as const) {
        if (key in body) {
          throw new ConfigValidationException([{ path: key, message: `${key} cannot change; create a new field instead` }]);
        }
      }
    }
    const { requiredRollout, ...changes } = parsed(updateCustomFieldSchema.safeParse(body));

    if (changes.required === true && !existing.required && !requiredRollout) {
      throw new ConfigValidationException([
        { path: 'requiredRollout', message: 'Say how existing records are treated: "new_and_edited" applies this to new and edited records only' },
      ]);
    }
    const removed = changes.options === undefined ? [] : removedOptionValues(existing.options, changes.options);
    if (removed.length) {
      throw new ConflictException({
        message: 'Options cannot be removed; mark them archived so existing values stay readable',
        code: 'CUSTOM_FIELD_OPTION_REMOVED',
        details: { options: removed },
      });
    }

    this.assertValid({
      moduleKey: existing.moduleKey,
      fieldKey: existing.fieldKey,
      fieldType: changes.fieldType ?? existing.fieldType,
      options: changes.options === undefined ? existing.options : changes.options,
      validation: changes.validation === undefined ? existing.validation : changes.validation,
      defaultValue: changes.defaultValue === undefined ? existing.defaultValue : changes.defaultValue,
    });

    if (
      changes.fieldType &&
      changes.fieldType !== existing.fieldType &&
      (await customFieldHasValues(this.prisma, companyId, existing.moduleKey, existing.fieldKey))
    ) {
      throw new ConflictException({
        message: 'The type cannot change once records hold a value for this field; create a new field instead',
        code: 'CUSTOM_FIELD_TYPE_LOCKED',
      });
    }

    const after = await this.prisma.customFieldDefinition.update({
      where: { id },
      data: {
        ...(changes.label !== undefined ? { label: changes.label } : {}),
        ...(changes.fieldType !== undefined ? { fieldType: changes.fieldType } : {}),
        ...(changes.options !== undefined ? { options: jsonOrNull(changes.options) } : {}),
        ...(changes.validation !== undefined ? { validation: jsonOrNull(changes.validation) } : {}),
        ...(changes.required !== undefined ? { required: changes.required } : {}),
        ...(changes.defaultValue !== undefined ? { defaultValue: jsonOrNull(changes.defaultValue) } : {}),
        ...(changes.searchable !== undefined ? { searchable: changes.searchable } : {}),
        ...(changes.readRoles !== undefined ? { readRoles: changes.readRoles } : {}),
        ...(changes.writeRoles !== undefined ? { writeRoles: changes.writeRoles } : {}),
        ...(changes.sortOrder !== undefined ? { sortOrder: changes.sortOrder } : {}),
      },
    });
    return { before: existing, after };
  }

  /** Fields are archived, never deleted: values stay stored and the field can be restored. */
  async setArchived(companyId: string, id: string, archived: boolean): Promise<CustomFieldDefinition> {
    const existing = await this.findOwned(companyId, id);
    if (Boolean(existing.archivedAt) === archived) return existing;
    return this.prisma.customFieldDefinition.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
    });
  }

  private assertValid(field: Parameters<typeof customFieldIssues>[0]): void {
    const issues = customFieldIssues(field);
    if (issues.length) throw new ConfigValidationException(issues);
  }

  private async findOwned(companyId: string, id: string): Promise<CustomFieldDefinition> {
    const row = await this.prisma.customFieldDefinition.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException('Custom field not found');
    return row;
  }
}
