import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MeConfig } from '@/api/me-config';
import { PageHeader } from '@/components/shared/page-header';
import { useBreadcrumbs } from '@/hooks/use-breadcrumbs';
import { fieldLabel, missingFieldsMessage, visibleColumns, withoutHiddenFields } from '@/lib/module-field-ui';
import { useAuthStore, type AuthUser } from '@/store/authStore';
import { useCustomModuleLabel, useModuleFields, useModuleUsable } from './use-module-config';

// jsdom has no matchMedia; the breadcrumb bar uses it to pick a compact layout.
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

const user: AuthUser = { id: 'u1', email: 'u@example.com', name: 'U', role: 'OWNER', shopId: null, companyId: 'c1', permissions: [] };
type ModuleEntry = MeConfig['modules'][string];

function setConfig(modules: Record<string, Omit<Partial<ModuleEntry>, 'config'> & { config?: Partial<ModuleEntry['config']> }>) {
  const data: MeConfig = {
    version: 2,
    modules: Object.fromEntries(
      Object.entries(modules).map(([key, m]) => [
        key,
        { usable: true, label: key, ...m, config: { mandatoryFields: [], hiddenFields: [], ...m.config } },
      ]),
    ),
    sidebar: [],
    preferences: {},
  };
  useAuthStore.getState().setMeConfig({ userId: user.id, etag: null, data });
}

const at = (path: string) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };

beforeEach(() => {
  useAuthStore.getState().clear();
  useAuthStore.getState().setSession('tok', user);
});

describe('useModuleFields', () => {
  it('treats every field as visible and optional when no config is loaded (today)', () => {
    const { result } = renderHook(() => useModuleFields('invoices'));
    expect(result.current.isHidden('remarks')).toBe(false);
    expect(result.current.isRequired('remarks')).toBe(false);
    expect(result.current.missing({ remarks: '' })).toEqual([]);
  });

  it('reports hidden and mandatory fields; a field both hidden and mandatory counts as hidden', () => {
    setConfig({ invoices: { config: { hiddenFields: ['dueDate'], mandatoryFields: ['remarks', 'dueDate'] } } });
    const { result } = renderHook(() => useModuleFields('invoices'));
    expect(result.current.isHidden('dueDate')).toBe(true);
    expect(result.current.isRequired('dueDate')).toBe(false);
    expect(result.current.isRequired('remarks')).toBe(true);
    expect(result.current.missing({ remarks: '  ', dueDate: '' })).toEqual(['remarks']);
    expect(result.current.missing({ remarks: 'ok' })).toEqual([]);
  });
});

describe('useModuleUsable', () => {
  it('allows everything without config, then follows usable by key or path', () => {
    const before = renderHook(() => useModuleUsable());
    expect(before.result.current('/purchase-orders')).toBe(true);
    setConfig({ 'purchase-orders': { usable: false }, reports: { usable: true } });
    const { result } = renderHook(() => useModuleUsable());
    expect(result.current('/purchase-orders/new')).toBe(false);
    expect(result.current('purchase-orders')).toBe(false);
    expect(result.current('/reports?tab=low-stock')).toBe(true);
    expect(result.current('/profile')).toBe(true);
  });
});

describe('custom module labels', () => {
  it('apply only to a module list page, only when the organisation set one, never to settings', () => {
    setConfig({ plants: { config: { label: 'Branches' } }, products: {}, settings: { config: { label: 'Prefs' } } });
    const { result } = renderHook(() => useCustomModuleLabel());
    expect(result.current('/plants')).toBe('Branches');
    expect(result.current('/plants/new')).toBeUndefined();
    expect(result.current('/products')).toBeUndefined();
    expect(result.current('/settings')).toBeUndefined();
  });

  it('PageHeader on the list page shows the custom label; elsewhere its own title', () => {
    setConfig({ plants: { config: { label: 'Branches' } } });
    const { unmount } = render(<PageHeader title="Locations" />, { wrapper: at('/plants') });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Branches');
    unmount();
    render(<PageHeader title="Add Location" />, { wrapper: at('/plants/new') });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Add Location');
  });

  it('PageHeader is unchanged with no published label', () => {
    render(<PageHeader title="Locations" />, { wrapper: at('/plants') });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Locations');
  });

  it('breadcrumbs pointing at the module list page use the custom label', () => {
    setConfig({ plants: { config: { label: 'Branches' } } });
    const list = renderHook(() => useBreadcrumbs(), { wrapper: at('/plants') });
    expect(list.result.current.items.at(-1)?.label).toBe('Branches');
    const create = renderHook(() => useBreadcrumbs(), { wrapper: at('/plants/new') });
    expect(create.result.current.items.map((i) => i.label)).toContain('Branches');
    expect(create.result.current.items.at(-1)?.label).toBe('New Shop');
  });
});

describe('module field UI helpers', () => {
  it('drops hidden columns, marks required labels and lists missing fields', () => {
    const hidden = (f: string) => f === 'remarks';
    expect(visibleColumns([{ header: 'A' }, { header: 'R', field: 'remarks' }, { header: 'D', field: 'dueDate' }], hidden).map((c) => c.header)).toEqual(['A', 'D']);
    expect(fieldLabel('Due Date', true)).toBe('Due Date *');
    expect(fieldLabel('Due Date', false)).toBe('Due Date');
    expect(missingFieldsMessage([], {})).toBeNull();
    expect(missingFieldsMessage(['dueDate', 'remarks'], { dueDate: 'Due Date' })).toBe('Fill in the required fields: Due Date, remarks');
  });

  it('strips hidden fields from a payload and each of its lines', () => {
    const hidden = (f: string) => f === 'remarks' || f === 'lineCategory';
    expect(
      withoutHiddenFields({ supplier: 'S', remarks: 'x', items: [{ qty: 1, lineCategory: 'c' }] }, hidden, 'items'),
    ).toEqual({ supplier: 'S', items: [{ qty: 1 }] });
  });
});
