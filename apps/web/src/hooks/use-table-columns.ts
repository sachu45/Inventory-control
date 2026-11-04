import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { MeUserPreferences } from '@/api/me-config';
import { useMeConfig } from '@/hooks/use-me-config';
import { useModuleFields } from '@/hooks/use-module-config';
import { movedOrder, resolveColumnState, type ColumnState, type TableColumn } from '@/lib/table-columns';
import { useAuthStore } from '@/store/authStore';

export type TableColumnsApi<Row> = {
  /** Columns to render, in order. */
  visible: TableColumn<Row>[];
  /** Every column the user may choose from, for the picker. */
  all: ColumnState<Row>[];
  saving: boolean;
  toggle: (key: string) => void;
  move: (key: string, delta: -1 | 1) => void;
  reset: () => void;
};

/**
 * A list table's columns with the user's saved order and visibility (preference scope
 * = module key) on top of the organisation's config: config-hidden fields never show,
 * config-mandatory fields cannot be hidden. With no preferences, `visible` is `columns`.
 */
export function useTableColumns<Row>(moduleKey: string, columns: TableColumn<Row>[]): TableColumnsApi<Row> {
  const meConfig = useMeConfig();
  const fields = useModuleFields(moduleKey);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const prefs = meConfig?.preferences[moduleKey];

  const all = useMemo(
    () => resolveColumnState(columns, prefs, { isFieldHidden: fields.isHidden, isFieldRequired: fields.isRequired }),
    [columns, prefs, fields],
  );

  const save = async (next: { columnOrder?: string[]; hiddenColumns?: string[] }) => {
    const stored = useAuthStore.getState().meConfig;
    const merged: MeUserPreferences = { ...prefs, ...next };
    for (const key of ['columnOrder', 'hiddenColumns'] as const) {
      if (merged[key]?.length === 0) delete merged[key];
    }
    // Show the change at once; the server copy follows via the /me/config refetch.
    if (stored) {
      useAuthStore.getState().setMeConfig({
        ...stored,
        data: { ...stored.data, preferences: { ...stored.data.preferences, [moduleKey]: merged } },
      });
    }
    setSaving(true);
    try {
      await api.put(`/me/preferences/${encodeURIComponent(moduleKey)}`, merged);
    } finally {
      setSaving(false);
      void queryClient.invalidateQueries({ queryKey: ['me-config'] });
    }
  };

  const hiddenKeys = all.filter((c) => !c.visible).map((c) => c.key);

  return {
    visible: all.filter((c) => c.visible),
    all,
    saving,
    toggle: (key) => {
      const column = all.find((c) => c.key === key);
      if (!column?.canHide) return;
      void save({
        hiddenColumns: column.visible ? [...hiddenKeys, key] : hiddenKeys.filter((k) => k !== key),
      });
    },
    move: (key, delta) => void save({ columnOrder: movedOrder(all, key, delta) }),
    reset: () => void save({ columnOrder: [], hiddenColumns: [] }),
  };
}
