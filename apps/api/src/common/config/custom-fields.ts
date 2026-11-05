import { RoleName } from '@prisma/client';
import { z } from 'zod';
import { MODULE_KEYS, MODULE_REGISTRY, ModuleKey, isModuleKey } from './module-registry';

/** Where each module stores custom field values (spec §4.5). Constant: table names reach raw SQL. */
export const CUSTOM_FIELD_TABLES: Partial<Record<ModuleKey, string>> = {
  products: 'products',
  suppliers: 'suppliers',
  customers: 'customers',
  'purchase-orders': 'purchase_order_header',
  'goods-receipts': 'goods_receipt_header',
  sales: 'sales_order_header',
  'goods-issues': 'goods_issue_header',
  invoices: 'invoice_header',
};

export const CUSTOM_FIELD_MODULES = MODULE_KEYS.filter((key) => MODULE_REGISTRY[key].supportsCustomFields);

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select', 'multiselect'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

const FIELD_KEY = /^[a-z][a-z0-9_]{1,39}$/;
const OPTION_TYPES: readonly CustomFieldType[] = ['select', 'multiselect'];
const MAX_PATTERN_LENGTH = 200;

export type CustomFieldOption = { value: string; label: string; archived?: boolean };
export type CustomFieldValidation = { min?: number; max?: number; maxLength?: number; pattern?: string };

/** A definition as published in a config snapshot. */
export type CustomFieldSnapshot = {
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options?: CustomFieldOption[];
  validation?: CustomFieldValidation;
  required: boolean;
  defaultValue?: unknown;
  searchable: boolean;
  readRoles: string[];
  writeRoles: string[];
  sortOrder: number;
};

const optionSchema = z.strictObject({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  archived: z.boolean().optional(),
});

const validationSchema = z.strictObject({
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  maxLength: z.number().int().positive().max(10_000).optional(),
  pattern: z.string().min(1).max(MAX_PATTERN_LENGTH).optional(),
});

const roles = z.array(z.enum(Object.values(RoleName) as [string, ...string[]])).max(20);

/** The fields an admin edits. `fieldKey` and `moduleKey` are only set on create. */
const editable = {
  label: z.string().trim().min(1).max(200),
  fieldType: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(optionSchema).min(1).max(200).nullable(),
  validation: validationSchema.nullable(),
  required: z.boolean(),
  defaultValue: z.unknown(),
  searchable: z.boolean(),
  readRoles: roles,
  writeRoles: roles,
  sortOrder: z.number().int().min(-100_000).max(100_000),
};

export const createCustomFieldSchema = z.strictObject({
  moduleKey: z.string(),
  fieldKey: z.string().regex(FIELD_KEY, 'Must start with a letter and use only lowercase letters, digits and _ (2-40 characters)'),
  label: editable.label,
  fieldType: editable.fieldType,
  options: editable.options.optional(),
  validation: editable.validation.optional(),
  required: editable.required.optional(),
  defaultValue: editable.defaultValue.optional(),
  searchable: editable.searchable.optional(),
  readRoles: editable.readRoles.optional(),
  writeRoles: editable.writeRoles.optional(),
  sortOrder: editable.sortOrder.optional(),
});

export const updateCustomFieldSchema = z.strictObject({
  label: editable.label.optional(),
  fieldType: editable.fieldType.optional(),
  options: editable.options.optional(),
  validation: editable.validation.optional(),
  required: editable.required.optional(),
  defaultValue: editable.defaultValue.optional(),
  searchable: editable.searchable.optional(),
  readRoles: editable.readRoles.optional(),
  writeRoles: editable.writeRoles.optional(),
  sortOrder: editable.sortOrder.optional(),
  /**
   * Required when turning `required` on. Only `new_and_edited` exists today: existing
   * records stay as they are until next edited. Backfill arrives with value enforcement.
   */
  requiredRollout: z.literal('new_and_edited').optional(),
});

export type CustomFieldShape = {
  moduleKey: string;
  fieldKey: string;
  fieldType: string;
  options?: unknown;
  validation?: unknown;
  defaultValue?: unknown;
};

type Issue = { path: string; message: string };

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function defaultValueIssue(field: CustomFieldShape, options: CustomFieldOption[]): string | null {
  const value = field.defaultValue;
  if (value === undefined || value === null) return null;
  const selectable = new Set(options.filter((o) => !o.archived).map((o) => o.value));
  switch (field.fieldType) {
    case 'text':
      return typeof value === 'string' ? null : 'Default must be text';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'Default must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Default must be true or false';
    case 'date':
      return typeof value === 'string' && isCalendarDate(value) ? null : 'Default must be a date as YYYY-MM-DD';
    case 'select':
      return typeof value === 'string' && selectable.has(value) ? null : 'Default must be an active option';
    case 'multiselect':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && selectable.has(v))
        ? null
        : 'Default must be a list of active options';
    default:
      return null;
  }
}

/** Rules that span fields: options and validation must suit the type, the default must fit both. */
export function customFieldIssues(field: CustomFieldShape): Issue[] {
  const issues: Issue[] = [];
  if (!isModuleKey(field.moduleKey)) {
    return [{ path: 'moduleKey', message: `Unknown module "${field.moduleKey}"` }];
  }
  if (!MODULE_REGISTRY[field.moduleKey].supportsCustomFields) {
    issues.push({ path: 'moduleKey', message: `${MODULE_REGISTRY[field.moduleKey].label} does not support custom fields` });
  }

  const options = (field.options ?? []) as CustomFieldOption[];
  const usesOptions = OPTION_TYPES.includes(field.fieldType as CustomFieldType);
  if (usesOptions && options.length === 0) {
    issues.push({ path: 'options', message: 'Select fields need at least one option' });
  }
  if (!usesOptions && options.length > 0) {
    issues.push({ path: 'options', message: `A ${field.fieldType} field cannot have options` });
  }
  const values = options.map((o) => o.value);
  if (new Set(values).size !== values.length) {
    issues.push({ path: 'options', message: 'Option values must be unique' });
  }

  const rules = (field.validation ?? {}) as CustomFieldValidation;
  if ((rules.min !== undefined || rules.max !== undefined) && field.fieldType !== 'number') {
    issues.push({ path: 'validation', message: 'min and max apply to number fields only' });
  }
  if (rules.min !== undefined && rules.max !== undefined && rules.min > rules.max) {
    issues.push({ path: 'validation', message: 'min cannot be greater than max' });
  }
  if ((rules.maxLength !== undefined || rules.pattern !== undefined) && field.fieldType !== 'text') {
    issues.push({ path: 'validation', message: 'maxLength and pattern apply to text fields only' });
  }
  if (rules.pattern !== undefined) {
    try {
      new RegExp(rules.pattern);
    } catch {
      issues.push({ path: 'validation.pattern', message: 'Not a valid regular expression' });
    }
  }

  const defaultIssue = defaultValueIssue(field, options);
  if (defaultIssue) issues.push({ path: 'defaultValue', message: defaultIssue });
  return issues;
}

/** Option values an update dropped. Options are archived rather than removed, so existing values stay readable. */
export function removedOptionValues(before: unknown, after: unknown): string[] {
  const kept = new Set(((after ?? []) as CustomFieldOption[]).map((o) => o.value));
  return ((before ?? []) as CustomFieldOption[]).map((o) => o.value).filter((value) => !kept.has(value));
}

/** The published form of a definition row; absent optional parts are left out. */
export function toCustomFieldSnapshot(row: {
  fieldKey: string;
  label: string;
  fieldType: string;
  options?: unknown;
  validation?: unknown;
  required: boolean;
  defaultValue?: unknown;
  searchable: boolean;
  readRoles: string[];
  writeRoles: string[];
  sortOrder: number;
}): CustomFieldSnapshot {
  return {
    fieldKey: row.fieldKey,
    label: row.label,
    fieldType: row.fieldType as CustomFieldType,
    ...(row.options ? { options: row.options as CustomFieldOption[] } : {}),
    ...(row.validation ? { validation: row.validation as CustomFieldValidation } : {}),
    required: row.required,
    ...(row.defaultValue !== null && row.defaultValue !== undefined ? { defaultValue: row.defaultValue } : {}),
    searchable: row.searchable,
    readRoles: row.readRoles,
    writeRoles: row.writeRoles,
    sortOrder: row.sortOrder,
  };
}
