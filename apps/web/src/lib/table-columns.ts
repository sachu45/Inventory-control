import type { ReactNode } from 'react';

/** One column of a list table, rendered in the user's chosen order. */
export type TableColumn<Row> = {
  key: string;
  label: string;
  /** Module config field the column shows; hidden by config means never shown. */
  field?: string;
  /** Identifier and action columns: always shown, cannot be hidden by the user. */
  locked?: boolean;
  headClassName?: string;
  cellClassName?: string;
  cell: (row: Row) => ReactNode;
};

export type ColumnPrefs = { columnOrder?: string[]; hiddenColumns?: string[] };

export type ColumnRules = {
  /** Field hidden by the organisation's config. */
  isFieldHidden: (field: string) => boolean;
  /** Field made mandatory by the organisation's config; its column cannot be hidden. */
  isFieldRequired: (field: string) => boolean;
};

export type ColumnState<Row> = TableColumn<Row> & { visible: boolean; canHide: boolean };

/**
 * Every column the user may see, in their order, with visibility applied.
 * Columns hidden by config are dropped entirely; a saved order that misses a column
 * (e.g. one added later) keeps it in its default position.
 */
export function resolveColumnState<Row>(
  columns: TableColumn<Row>[],
  prefs: ColumnPrefs | undefined,
  rules: ColumnRules,
): ColumnState<Row>[] {
  const allowed = columns.filter((c) => !c.field || !rules.isFieldHidden(c.field));
  const rank = new Map((prefs?.columnOrder ?? []).map((key, i) => [key, i]));
  const ordered = allowed
    .filter((c) => rank.has(c.key))
    .sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  allowed.forEach((column, index) => {
    if (!rank.has(column.key)) ordered.splice(Math.min(index, ordered.length), 0, column);
  });
  const hidden = new Set(prefs?.hiddenColumns ?? []);
  return ordered.map((column) => {
    const canHide = !column.locked && !(column.field && rules.isFieldRequired(column.field));
    return { ...column, canHide, visible: !canHide || !hidden.has(column.key) };
  });
}

/** Preferences after moving `key` up (-1) or down (+1) among the current columns. */
export function movedOrder(state: { key: string }[], key: string, delta: -1 | 1): string[] {
  const keys = state.map((c) => c.key);
  const from = keys.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= keys.length) return keys;
  [keys[from], keys[to]] = [keys[to], keys[from]];
  return keys;
}
