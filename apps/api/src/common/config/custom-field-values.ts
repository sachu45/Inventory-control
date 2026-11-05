import { applyDecorators, HttpException, HttpStatus, SetMetadata } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { IsObject, IsOptional } from 'class-validator';
import { isCalendarDate, type CustomFieldSnapshot } from './custom-fields';

export type CustomFieldIssue = { path: string; message: string };
type Values = Record<string, unknown>;

/** Text longer than this is refused whatever the field's own limit, and keeps pattern checks cheap. */
export const MAX_TEXT_VALUE_LENGTH = 10_000;

export class CustomFieldValuesException extends HttpException {
  constructor(public readonly details: CustomFieldIssue[]) {
    super({ message: 'Invalid custom field values', code: 'CUSTOM_FIELDS_INVALID', details }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

/** Marks a create or update handler whose body may carry `customFields`, validated by CustomFieldsInterceptor. */
export const CUSTOM_FIELDS_WRITE_KEY = 'customFieldsWrite';
export const CustomFieldsWrite = (mode: 'create' | 'update') => SetMetadata(CUSTOM_FIELDS_WRITE_KEY, mode);

/** A route that returns config itself, where `customFields` means definitions rather than a record's values. */
export const CUSTOM_FIELDS_PASSTHROUGH_KEY = 'customFieldsPassthrough';
export const CustomFieldsPassthrough = () => SetMetadata(CUSTOM_FIELDS_PASSTHROUGH_KEY, true);

/** On a DTO: the shape only. The values were already checked against published definitions by the interceptor. */
export const CustomFieldsProperty = () =>
  applyDecorators(
    ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Values of published custom fields' }),
    IsOptional(),
    IsObject(),
  );

/** For a Prisma `data` block: undefined leaves the column alone. */
export const customFieldsInput = (values?: Values): Prisma.InputJsonValue | undefined =>
  values as Prisma.InputJsonValue | undefined;

const allowedTo = (roles: string[], role: string) => roles.length === 0 || roles.includes(role);
export const canReadField = (field: CustomFieldSnapshot, role: string) => allowedTo(field.readRoles, role);
export const canWriteField = (field: CustomFieldSnapshot, role: string) => allowedTo(field.writeRoles, role);

const isPlainObject = (value: unknown): value is Values => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

const isEmptyValue = (value: unknown) =>
  value === null || value === '' || (Array.isArray(value) && value.length === 0);

/** Why a submitted value does not fit its field, or null. An archived option stays valid only if the record already holds it. */
function valueIssue(field: CustomFieldSnapshot, value: unknown, stored: unknown): string | null {
  const rules = field.validation ?? {};
  switch (field.fieldType) {
    case 'text': {
      if (typeof value !== 'string') return 'Must be text';
      const limit = Math.min(rules.maxLength ?? MAX_TEXT_VALUE_LENGTH, MAX_TEXT_VALUE_LENGTH);
      if (value.length > limit) return `Must be at most ${limit} characters`;
      if (rules.pattern !== undefined && !new RegExp(rules.pattern).test(value)) return 'Does not match the required format';
      return null;
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Must be a number';
      if (rules.min !== undefined && value < rules.min) return `Must be at least ${rules.min}`;
      if (rules.max !== undefined && value > rules.max) return `Must be at most ${rules.max}`;
      return null;
    case 'date':
      return typeof value === 'string' && isCalendarDate(value) ? null : 'Must be a date as YYYY-MM-DD';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Must be true or false';
    case 'select':
    case 'multiselect': {
      const multi = field.fieldType === 'multiselect';
      if (multi ? !Array.isArray(value) : typeof value !== 'string') return multi ? 'Must be a list of options' : 'Must be an option';
      const held = new Set(Array.isArray(stored) ? stored : [stored]);
      const usable = new Set((field.options ?? []).filter((o) => !o.archived || held.has(o.value)).map((o) => o.value));
      const chosen = (multi ? value : [value]) as unknown[];
      if (new Set(chosen).size !== chosen.length) return 'Options must not repeat';
      return chosen.every((v) => typeof v === 'string' && usable.has(v)) ? null : 'Not an available option';
    }
    default:
      return 'Unsupported field type';
  }
}

/**
 * The values to store for a create or update, or `undefined` to leave the column alone.
 * Fields the request does not name keep their stored value, including ones this user
 * cannot see and archived ones, which is why the result merges rather than replaces.
 */
export function resolveCustomFieldWrite(args: {
  fields: CustomFieldSnapshot[];
  role: string;
  submitted: unknown;
  stored: unknown;
  mode: 'create' | 'update';
}): { issues: CustomFieldIssue[]; values?: Values } {
  const { fields, role, submitted, mode } = args;
  if (submitted !== undefined && !isPlainObject(submitted)) {
    return { issues: [{ path: 'customFields', message: 'Must be an object' }] };
  }
  const stored = isPlainObject(args.stored) ? args.stored : {};
  const byKey = new Map(fields.map((f) => [f.fieldKey, f]));
  const issues: CustomFieldIssue[] = [];
  const next: Values = { ...stored };

  for (const [key, value] of Object.entries(submitted ?? {})) {
    const path = `customFields.${key}`;
    const field = byKey.get(key);
    if (!field) {
      issues.push({ path, message: 'Unknown custom field' });
    } else if (!canWriteField(field, role)) {
      issues.push({ path, message: 'You cannot change this field' });
    } else if (isEmptyValue(value)) {
      delete next[key];
    } else {
      const issue = valueIssue(field, value, stored[key]);
      if (issue) issues.push({ path, message: issue });
      else next[key] = value;
    }
  }

  let defaulted = false;
  if (mode === 'create') {
    for (const field of fields) {
      if (field.defaultValue !== undefined && !(field.fieldKey in next) && !Object.hasOwn(submitted ?? {}, field.fieldKey)) {
        next[field.fieldKey] = field.defaultValue;
        defaulted = true;
      }
    }
  }

  // A required field applies to new and edited records. Someone who may not write it cannot be blocked by it.
  for (const field of fields) {
    if (field.required && canWriteField(field, role) && !(field.fieldKey in next)) {
      issues.push({ path: `customFields.${field.fieldKey}`, message: `${field.label} is required` });
    }
  }

  if (issues.length) return { issues };
  if (submitted === undefined && !defaulted) return { issues: [] };
  return { issues: [], values: next };
}

const isRecordWithId = (node: Values) => 'id' in node;

/**
 * Removes custom field values a response must not carry. Only the route's own records keep
 * theirs, limited to published fields this role may read: the first object with an `id` on
 * each path is such a record. Values nested beneath it belong to some other module (a PO's
 * supplier, a stock row's product) whose rules do not apply here, so they are removed, as
 * they are on every route without a module. Files, dates and decimals pass through untouched.
 */
export function redactCustomFields<T>(value: T, fields: CustomFieldSnapshot[] | null, role: string): T {
  const readable = new Set((fields ?? []).filter((f) => canReadField(f, role)).map((f) => f.fieldKey));

  const walk = (node: unknown, insideRecord: boolean): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, insideRecord));
    if (!isPlainObject(node)) return node;
    const own = !insideRecord && fields !== null;
    const below = insideRecord || isRecordWithId(node);
    const copy: Values = {};
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'customFields') {
        copy[key] = walk(child, below);
      } else if (own && isPlainObject(child)) {
        copy[key] = Object.fromEntries(Object.entries(child).filter(([k]) => readable.has(k)));
      } else if (own && child === null) {
        copy[key] = null;
      }
    }
    return copy;
  };
  return walk(value, false) as T;
}
