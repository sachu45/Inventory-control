import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useMeConfig } from '@/hooks/use-me-config';
import {
  customFieldErrorsFromApi,
  formatCustomFieldValue,
  initialCustomFieldValues,
  isBlankValue,
  validateCustomFields,
  type CustomField,
  type CustomFieldErrors,
  type CustomFieldValues,
} from '@/lib/custom-fields';
import type { TableColumn } from '@/lib/table-columns';

/** The published custom fields of a module this user may read, in display order. */
export function useCustomFields(moduleKey: string): CustomField[] {
  const meConfig = useMeConfig();
  const fields = meConfig?.modules[moduleKey]?.config.customFields;
  return useMemo(() => [...(fields ?? [])].sort((a, b) => a.sortOrder - b.sortOrder), [fields]);
}

/**
 * Form state for a module's custom fields. Only fields the user changed are sent, because
 * the API keeps everything else: a row that came without a value can't wipe the stored one.
 */
export function useCustomFieldForm(moduleKey: string) {
  const fields = useCustomFields(moduleKey);
  const [values, setValues] = useState<CustomFieldValues>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<CustomFieldErrors>({});
  const [isNew, setIsNew] = useState(true);

  // Config can load after the form opens; a new record still gets its defaults.
  useEffect(() => {
    if (isNew && touched.size === 0) setValues(initialCustomFieldValues(fields));
  }, [fields, isNew, touched]);

  /** Call when the form opens: with the record to edit, or with nothing for a new one. */
  const reset = useCallback((record?: { customFields?: unknown } | null) => {
    setIsNew(!record);
    // A new record's defaults come from the effect above. Stable on purpose: a config
    // refetch must not re-run the effects that call this and wipe a half-filled form.
    setValues(record ? { ...((record.customFields ?? {}) as CustomFieldValues) } : {});
    setTouched(new Set());
    setErrors({});
  }, []);

  const setValue = useCallback((key: string, value: unknown) => {
    setValues((current) => ({ ...current, [key]: value }));
    setTouched((current) => new Set(current).add(key));
    setErrors(({ [key]: _cleared, ...rest }) => rest);
  }, []);

  /** On a new record defaults count as present; on an edit an untouched field may just be missing from the row. */
  const validate = useCallback(() => {
    const merged = isNew ? { ...initialCustomFieldValues(fields), ...values } : values;
    const checked = isNew ? fields : fields.filter((field) => touched.has(field.fieldKey));
    const found = validateCustomFields(checked, merged);
    setErrors(found);
    const valid = Object.keys(found).length === 0;
    if (!valid) toast.error('Check the additional fields');
    return valid;
  }, [fields, isNew, touched, values]);

  /** Spread into the write payload. Empty when nothing changed, so forms without custom fields are unaffected. */
  const payload = useCallback((): { customFields?: CustomFieldValues } => {
    const changed: CustomFieldValues = {};
    for (const field of fields) {
      if (!field.writable || !touched.has(field.fieldKey)) continue;
      const value = values[field.fieldKey];
      changed[field.fieldKey] = isBlankValue(value) ? null : value;
    }
    return Object.keys(changed).length ? { customFields: changed } : {};
  }, [fields, touched, values]);

  /** Shows a server rejection beside its fields. Returns false if the error was about something else. */
  const showApiErrors = useCallback((err: unknown) => {
    const found = customFieldErrorsFromApi(err);
    if (!found) return false;
    setErrors(found);
    toast.error('Check the additional fields');
    return true;
  }, []);

  return { fields, values, errors, setValue, reset, validate, payload, showApiErrors };
}

export type CustomFieldForm = ReturnType<typeof useCustomFieldForm>;

/** Table columns for a module's custom fields, placed before Actions by {@link withCustomFieldColumns}. */
export function customFieldColumns<Row extends { customFields?: unknown }>(fields: CustomField[]): TableColumn<Row>[] {
  return fields.map((field) => ({
    key: `custom:${field.fieldKey}`,
    label: field.label,
    cell: (row: Row) => formatCustomFieldValue(field, (row.customFields as CustomFieldValues | null | undefined)?.[field.fieldKey]) || '—',
  }));
}

export function withCustomFieldColumns<Row extends { customFields?: unknown }>(
  columns: TableColumn<Row>[],
  fields: CustomField[],
): TableColumn<Row>[] {
  if (!fields.length) return columns;
  const extra = customFieldColumns<Row>(fields);
  const actions = columns.findIndex((column) => column.key === 'actions');
  if (actions < 0) return [...columns, ...extra];
  return [...columns.slice(0, actions), ...extra, ...columns.slice(actions)];
}
