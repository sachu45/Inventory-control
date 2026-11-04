import { HttpException, HttpStatus } from '@nestjs/common';
import { z } from 'zod';

const MAX_ITEMS = 200;
const key = z.string().min(1).max(100);
const keyList = z.array(key).max(MAX_ITEMS);
const filterScalar = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

// Strict: preferences are personal UI state only, so any key outside this list
// (e.g. an attempt to toggle modules or mandatory fields) is rejected.
export const userPreferencesSchema = z.strictObject({
  columnOrder: keyList.optional(),
  hiddenColumns: keyList.optional(),
  defaultSort: z
    .strictObject({ field: key, direction: z.enum(['asc', 'desc']) })
    .optional(),
  defaultFilters: z
    .record(key, z.union([filterScalar, z.array(filterScalar).max(MAX_ITEMS)]))
    .optional(),
  pinned: keyList.optional(),
  order: keyList.optional(),
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export class InvalidPreferencesException extends HttpException {
  constructor(public readonly details: { path: string; message: string }[]) {
    super({ message: 'Invalid preferences', code: 'INVALID_PREFERENCES', details }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

export function parseUserPreferences(input: unknown): UserPreferences {
  const result = userPreferencesSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidPreferencesException(
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

/** Drops hidden columns the business config makes mandatory; applied on every read. */
export function applyMandatoryColumns(
  prefs: UserPreferences,
  mandatoryColumns: ReadonlySet<string>,
): UserPreferences {
  if (!prefs.hiddenColumns?.length || mandatoryColumns.size === 0) return prefs;
  return { ...prefs, hiddenColumns: prefs.hiddenColumns.filter((column) => !mandatoryColumns.has(column)) };
}
