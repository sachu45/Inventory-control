/** A published custom field as /me/config gives it to this user. */
export type CustomField = {
  fieldKey: string;
  label: string;
  fieldType: 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multiselect';
  options?: { value: string; label: string; archived?: boolean }[];
  validation?: { min?: number; max?: number; maxLength?: number; pattern?: string };
  required: boolean;
  defaultValue?: unknown;
  searchable: boolean;
  sortOrder: number;
  writable: boolean;
};

export type CustomFieldValues = Record<string, unknown>;
export type CustomFieldErrors = Record<string, string>;

export const isBlankValue = (value: unknown) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/**
 * What a user sees for a stored value. An archived option shows its label, and an
 * option removed from the list shows the raw value, so nothing stored reads as empty.
 */
export function formatCustomFieldValue(field: CustomField, value: unknown): string {
  if (isBlankValue(value)) return '';
  const label = (v: unknown) => field.options?.find((o) => o.value === v)?.label ?? String(v);
  switch (field.fieldType) {
    case 'boolean':
      return value === true ? 'Yes' : 'No';
    case 'select':
      return label(value);
    case 'multiselect':
      return Array.isArray(value) ? value.map(label).join(', ') : String(value);
    default:
      return String(value);
  }
}

/** Why a value does not fit, or null. Mirrors the API for quick feedback; the API has the final say. */
function valueError(field: CustomField, value: unknown): string | null {
  const rules = field.validation ?? {};
  if (field.fieldType === 'text' && typeof value === 'string') {
    if (rules.maxLength !== undefined && value.length > rules.maxLength) return `Must be at most ${rules.maxLength} characters`;
    if (rules.pattern !== undefined) {
      try {
        if (!new RegExp(rules.pattern).test(value)) return 'Does not match the required format';
      } catch {
        return null;
      }
    }
  }
  if (field.fieldType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Must be a number';
    if (rules.min !== undefined && value < rules.min) return `Must be at least ${rules.min}`;
    if (rules.max !== undefined && value > rules.max) return `Must be at most ${rules.max}`;
  }
  return null;
}

export function validateCustomFields(fields: CustomField[], values: CustomFieldValues): CustomFieldErrors {
  const errors: CustomFieldErrors = {};
  for (const field of fields) {
    if (!field.writable) continue;
    const value = values[field.fieldKey];
    if (isBlankValue(value)) {
      if (field.required) errors[field.fieldKey] = `${field.label} is required`;
      continue;
    }
    const error = valueError(field, value);
    if (error) errors[field.fieldKey] = error;
  }
  return errors;
}

/** Inline messages from a 422 `CUSTOM_FIELDS_INVALID` response, or null if the error is something else. */
export function customFieldErrorsFromApi(err: unknown): CustomFieldErrors | null {
  const body = (err as { response?: { data?: unknown } })?.response?.data as
    | { code?: string; details?: unknown; error?: { code?: string; details?: unknown } }
    | undefined;
  const code = body?.error?.code ?? body?.code;
  const details = body?.error?.details ?? body?.details;
  if (code !== 'CUSTOM_FIELDS_INVALID' || !Array.isArray(details)) return null;
  const errors: CustomFieldErrors = {};
  for (const issue of details as { path?: string; message?: string }[]) {
    const key = issue.path?.replace(/^customFields\.?/, '');
    if (key && issue.message) errors[key] = issue.message;
  }
  return errors;
}

/** Starting values: what the record holds, or on a new record each field's default. */
export function initialCustomFieldValues(fields: CustomField[], stored?: unknown): CustomFieldValues {
  if (stored && typeof stored === 'object') return { ...(stored as CustomFieldValues) };
  const values: CustomFieldValues = {};
  for (const field of fields) if (field.defaultValue !== undefined) values[field.fieldKey] = field.defaultValue;
  return values;
}
