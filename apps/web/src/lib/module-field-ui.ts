import type { CsvColumn } from '@/lib/csv';

/** Drops columns (table or CSV) bound to a field the organisation hid. */
export function visibleColumns<C extends { field?: string }>(columns: C[], isHidden: (field: string) => boolean): C[] {
  return columns.filter((column) => !column.field || !isHidden(column.field));
}

/** Label text with a required marker for organisation-mandatory fields. */
export function fieldLabel(text: string, required: boolean): string {
  return required ? `${text} *` : text;
}

/** "Fill in the required fields: Due Date, Remarks", or null when nothing is missing. */
export function missingFieldsMessage(missing: string[], labels: Record<string, string>): string | null {
  if (missing.length === 0) return null;
  return `Fill in the required ${missing.length === 1 ? 'field' : 'fields'}: ${missing.map((f) => labels[f] ?? f).join(', ')}`;
}

/** CSV export columns minus any bound to a hidden field. */
export function visibleCsvColumns<T>(
  columns: (CsvColumn<T> & { field?: string })[],
  isHidden: (field: string) => boolean,
): CsvColumn<T>[] {
  return visibleColumns(columns, isHidden);
}

/**
 * Copy of a write payload without hidden fields, at the top level and on each line
 * under `lineKey`. The API ignores hidden fields anyway; this keeps the UI honest.
 */
export function withoutHiddenFields<T extends object>(payload: T, isHidden: (field: string) => boolean, lineKey?: string): T {
  const strip = (obj: object) => Object.fromEntries(Object.entries(obj).filter(([key]) => !isHidden(key)));
  const result = strip(payload) as Record<string, unknown>;
  const lines = lineKey ? result[lineKey] : undefined;
  if (lineKey && Array.isArray(lines)) result[lineKey] = lines.map((line) => (line && typeof line === 'object' ? strip(line) : line));
  return result as T;
}
