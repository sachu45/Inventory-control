import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeConfig } from '@/api/me-config';
import { ColumnPicker } from '@/components/shared/column-picker';
import { movedOrder, resolveColumnState, type TableColumn } from '@/lib/table-columns';
import { useAuthStore, type AuthUser } from '@/store/authStore';
import { useTableColumns } from './use-table-columns';

const put = vi.fn();
vi.mock('@/api/client', () => ({ api: { put: (...args: unknown[]) => put(...args) } }));

type Row = { id: string };
const COLUMNS: TableColumn<Row>[] = [
  { key: 'number', label: 'Number', locked: true, cell: (r) => r.id },
  { key: 'date', label: 'Date', field: 'invoiceDate', cell: () => 'd' },
  { key: 'remarks', label: 'Remarks', field: 'remarks', cell: () => 'r' },
  { key: 'total', label: 'Total', field: 'total', cell: () => 't' },
  { key: 'actions', label: 'Actions', locked: true, cell: () => 'a' },
];
const keys = (cols: { key: string }[]) => cols.map((c) => c.key);
const noRules = { isFieldHidden: () => false, isFieldRequired: () => false };

const user: AuthUser = { id: 'u1', email: 'u@example.com', name: 'U', role: 'OWNER', shopId: null, companyId: 'c1', permissions: [] };

function setConfig(config: Partial<MeConfig['modules'][string]['config']>, preferences: MeConfig['preferences'] = {}) {
  useAuthStore.getState().setMeConfig({
    userId: user.id,
    etag: null,
    data: {
      version: 1,
      modules: { invoices: { usable: true, label: 'Invoices', config: { mandatoryFields: [], hiddenFields: [], ...config } } },
      sidebar: [],
      preferences,
    },
  });
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

beforeEach(() => {
  put.mockReset().mockResolvedValue({});
  useAuthStore.getState().clear();
  useAuthStore.getState().setSession('tok', user);
});

describe('resolveColumnState', () => {
  it('shows every column in default order with no preferences (today)', () => {
    const state = resolveColumnState(COLUMNS, undefined, noRules);
    expect(keys(state)).toEqual(keys(COLUMNS));
    expect(state.every((c) => c.visible)).toBe(true);
    expect(state.filter((c) => !c.canHide).map((c) => c.key)).toEqual(['number', 'actions']);
  });

  it('applies saved order and hidden columns; columns missing from the saved order keep their default slot', () => {
    const state = resolveColumnState(COLUMNS, { columnOrder: ['total', 'number', 'date', 'actions'], hiddenColumns: ['date'] }, noRules);
    expect(keys(state)).toEqual(['total', 'number', 'remarks', 'date', 'actions']);
    expect(keys(state.filter((c) => c.visible))).toEqual(['total', 'number', 'remarks', 'actions']);
  });

  it('never shows config-hidden fields, even if the user saved them visible or ordered them', () => {
    const state = resolveColumnState(COLUMNS, { columnOrder: ['remarks', 'number'] }, { ...noRules, isFieldHidden: (f) => f === 'remarks' });
    expect(keys(state)).not.toContain('remarks');
  });

  it('keeps config-mandatory and locked columns visible even when the user hid them', () => {
    const state = resolveColumnState(COLUMNS, { hiddenColumns: ['total', 'number', 'date'] }, { ...noRules, isFieldRequired: (f) => f === 'total' });
    expect(keys(state.filter((c) => c.visible))).toEqual(['number', 'remarks', 'total', 'actions']);
    expect(state.find((c) => c.key === 'total')?.canHide).toBe(false);
  });

  it('ignores unknown keys in saved preferences', () => {
    const state = resolveColumnState(COLUMNS, { columnOrder: ['gone', 'total'], hiddenColumns: ['gone'] }, noRules);
    expect(keys(state)).toEqual(['number', 'date', 'remarks', 'total', 'actions']);
    expect(state.every((c) => c.visible)).toBe(true);
  });
});

describe('movedOrder', () => {
  it('swaps a column with its neighbour and stays put at the edges', () => {
    const state = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
    expect(movedOrder(state, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(movedOrder(state, 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(movedOrder(state, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(movedOrder(state, 'c', 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('useTableColumns', () => {
  it('hides a column at once and saves it to the user preference scope', async () => {
    setConfig({}, { invoices: { pageSize: 50 } as never });
    const { result } = renderHook(() => useTableColumns('invoices', COLUMNS), { wrapper });
    act(() => result.current.toggle('remarks'));
    expect(keys(result.current.visible)).not.toContain('remarks');
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith('/me/preferences/invoices', { pageSize: 50, hiddenColumns: ['remarks'] });
    expect(useAuthStore.getState().meConfig?.data.preferences.invoices).toEqual({ pageSize: 50, hiddenColumns: ['remarks'] });
  });

  it('does not let locked or mandatory columns be hidden', () => {
    setConfig({ mandatoryFields: ['total'] });
    const { result } = renderHook(() => useTableColumns('invoices', COLUMNS), { wrapper });
    act(() => {
      result.current.toggle('number');
      result.current.toggle('total');
    });
    expect(put).not.toHaveBeenCalled();
    expect(keys(result.current.visible)).toEqual(keys(COLUMNS));
  });

  it('reset drops the column preferences but keeps other preferences', async () => {
    setConfig({}, { invoices: { columnOrder: ['total', 'number', 'date', 'remarks', 'actions'], hiddenColumns: ['date'], pageSize: 25 } as never });
    const { result } = renderHook(() => useTableColumns('invoices', COLUMNS), { wrapper });
    expect(keys(result.current.visible)[0]).toBe('total');
    act(() => result.current.reset());
    await waitFor(() => expect(put).toHaveBeenCalledWith('/me/preferences/invoices', { pageSize: 25 }));
    expect(keys(result.current.visible)).toEqual(keys(COLUMNS));
  });
});

describe('ColumnPicker', () => {
  function Table() {
    const columns = useTableColumns('invoices', COLUMNS);
    return (
      <>
        <ColumnPicker columns={columns} tableLabel="invoice" />
        <table>
          <thead>
            <tr>{columns.visible.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
          </thead>
        </table>
      </>
    );
  }
  const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent);

  it('hides and reorders columns, with locked and mandatory ones not hideable', async () => {
    setConfig({ mandatoryFields: ['total'], hiddenFields: ['remarks'] });
    const u = userEvent.setup();
    render(<Table />, { wrapper });
    expect(headers()).toEqual(['Number', 'Date', 'Total', 'Actions']);

    await u.click(screen.getByRole('button', { name: 'Choose invoice columns' }));
    expect(screen.queryByRole('checkbox', { name: 'Remarks' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Number' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Total' })).toBeDisabled();

    await u.click(screen.getByRole('checkbox', { name: 'Date' }));
    expect(headers()).toEqual(['Number', 'Total', 'Actions']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move Total up' })).toBeEnabled());

    await u.click(screen.getByRole('button', { name: 'Move Total up' }));
    expect(headers()).toEqual(['Number', 'Total', 'Actions']);
    expect(put).toHaveBeenLastCalledWith('/me/preferences/invoices', {
      hiddenColumns: ['date'],
      columnOrder: ['number', 'total', 'date', 'actions'],
    });
  });
});
