import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeConfig } from '@/api/me-config';
import { CustomFieldFilters, customFieldFilterParam } from '@/components/shared/custom-field-filters';
import { CustomFieldCells, CustomFieldHeads, CustomFieldsSection, CustomFieldValuesList } from '@/components/shared/custom-fields-section';
import {
  customFieldErrorsFromApi,
  formatCustomFieldValue,
  validateCustomFields,
  type CustomField,
} from '@/lib/custom-fields';
import { useAuthStore, type AuthUser } from '@/store/authStore';
import { useCustomFieldFilters, useCustomFieldForm, withCustomFieldColumns } from './use-custom-fields';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Radix Select needs these in jsdom.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => undefined;
});

const user: AuthUser = { id: 'u1', email: 'u@example.com', name: 'U', role: 'OWNER', shopId: null, companyId: 'c1', permissions: [] };

const field = (over: Partial<CustomField> & { fieldKey: string }): CustomField => ({
  label: over.fieldKey,
  fieldType: 'text',
  required: false,
  searchable: false,
  sortOrder: 0,
  writable: true,
  ...over,
});

function publish(fields: CustomField[], moduleKey = 'products') {
  const data: MeConfig = {
    version: 1,
    modules: { [moduleKey]: { usable: true, label: moduleKey, config: { mandatoryFields: [], hiddenFields: [], customFields: fields } } },
    sidebar: [],
    preferences: {},
  };
  useAuthStore.getState().setMeConfig({ userId: user.id, etag: null, data });
}

function Form() {
  const form = useCustomFieldForm('products');
  return <CustomFieldsSection form={form} />;
}

beforeEach(() => {
  useAuthStore.getState().clear();
  useAuthStore.getState().setSession('tok', user);
});

describe('custom field helpers', () => {
  it('shows stored values readably; an archived or removed option never reads as empty', () => {
    const select = field({ fieldKey: 's', fieldType: 'select', options: [{ value: 'a', label: 'Alpha' }, { value: 'old', label: 'Old', archived: true }] });
    expect(formatCustomFieldValue(select, 'a')).toBe('Alpha');
    expect(formatCustomFieldValue(select, 'old')).toBe('Old');
    expect(formatCustomFieldValue(select, 'gone')).toBe('gone');
    expect(formatCustomFieldValue({ ...select, fieldType: 'multiselect' }, ['a', 'old'])).toBe('Alpha, Old');
    expect(formatCustomFieldValue(field({ fieldKey: 'b', fieldType: 'boolean' }), false)).toBe('No');
    expect(formatCustomFieldValue(field({ fieldKey: 'n', fieldType: 'number' }), 0)).toBe('0');
    expect(formatCustomFieldValue(field({ fieldKey: 't' }), null)).toBe('');
  });

  it('mirrors the server rules', () => {
    const fields = [
      field({ fieldKey: 'req', label: 'Req', required: true }),
      field({ fieldKey: 'num', fieldType: 'number', validation: { min: 1, max: 5 } }),
      field({ fieldKey: 'txt', validation: { maxLength: 2, pattern: '^[A-Z]+$' } }),
      field({ fieldKey: 'locked', required: true, writable: false }),
    ];
    expect(validateCustomFields(fields, { req: 'x', num: 3, txt: 'AB' })).toEqual({});
    expect(Object.keys(validateCustomFields(fields, { num: 9, txt: 'abc' })).sort()).toEqual(['num', 'req', 'txt']);
    expect(validateCustomFields(fields, { req: 'x', txt: 'ab' }).txt).toBe('Does not match the required format');
  });

  it('reads per-field errors from the API, and ignores other errors', () => {
    const details = [{ path: 'customFields.grade', message: 'Not an available option' }];
    expect(customFieldErrorsFromApi({ response: { data: { error: { code: 'CUSTOM_FIELDS_INVALID', details } } } })).toEqual({ grade: 'Not an available option' });
    expect(customFieldErrorsFromApi({ response: { data: { code: 'CUSTOM_FIELDS_INVALID', details } } })).toEqual({ grade: 'Not an available option' });
    expect(customFieldErrorsFromApi({ response: { data: { error: { code: 'OTHER' } } } })).toBeNull();
    expect(customFieldErrorsFromApi(new Error('boom'))).toBeNull();
  });

  it('adds columns before Actions, and leaves tables alone with no fields', () => {
    const base = [{ key: 'name', label: 'Name', cell: () => 'n' }, { key: 'actions', label: 'Actions', locked: true, cell: () => 'a' }];
    expect(withCustomFieldColumns(base, [])).toBe(base);
    const columns = withCustomFieldColumns<{ customFields?: unknown }>(base, [field({ fieldKey: 'grade', label: 'Grade' })]);
    expect(columns.map((c) => c.key)).toEqual(['name', 'custom:grade', 'actions']);
    expect(columns[1].cell({ customFields: { grade: 'A' } })).toBe('A');
    expect(columns[1].cell({ customFields: null })).toBe('—');
  });
});

describe('useCustomFieldForm', () => {
  it('adds nothing to the payload with no fields, so existing forms are unchanged', () => {
    const { result } = renderHook(() => useCustomFieldForm('products'));
    expect(result.current.fields).toEqual([]);
    expect(result.current.payload()).toEqual({});
    let valid = false;
    act(() => { valid = result.current.validate(); });
    expect(valid).toBe(true);
  });

  it('sends only what the user changed, so a value missing from a list row is not wiped', () => {
    publish([field({ fieldKey: 'a' }), field({ fieldKey: 'b' })]);
    const { result } = renderHook(() => useCustomFieldForm('products'));
    act(() => result.current.reset({ customFields: null }));
    expect(result.current.payload()).toEqual({});
    act(() => result.current.setValue('a', 'new'));
    expect(result.current.payload()).toEqual({ customFields: { a: 'new' } });
  });

  it('clearing a field sends null; read-only fields are never sent', () => {
    publish([field({ fieldKey: 'a' }), field({ fieldKey: 'ro', writable: false })]);
    const { result } = renderHook(() => useCustomFieldForm('products'));
    act(() => result.current.reset({ customFields: { a: 'x', ro: 'y' } }));
    act(() => {
      result.current.setValue('a', '');
      result.current.setValue('ro', 'hacked');
    });
    expect(result.current.payload()).toEqual({ customFields: { a: null } });
  });

  it('a new record starts from defaults; editing starts from the record', () => {
    publish([field({ fieldKey: 'a', defaultValue: 'd' })]);
    const { result } = renderHook(() => useCustomFieldForm('products'));
    expect(result.current.values).toEqual({ a: 'd' });
    act(() => result.current.reset({ customFields: { a: 'stored' } }));
    expect(result.current.values).toEqual({ a: 'stored' });
    act(() => result.current.reset());
    expect(result.current.values).toEqual({ a: 'd' });
  });

  it('on a new record required fields are checked; on an edit only touched ones, since the API holds the rest', () => {
    publish([field({ fieldKey: 'a', label: 'A', required: true })]);
    const { result } = renderHook(() => useCustomFieldForm('products'));
    let valid = true;
    act(() => { valid = result.current.validate(); });
    expect(valid).toBe(false);
    expect(result.current.errors.a).toBe('A is required');

    act(() => result.current.reset({ customFields: null }));
    act(() => { valid = result.current.validate(); });
    expect(valid).toBe(true);
    act(() => result.current.setValue('a', ''));
    act(() => { valid = result.current.validate(); });
    expect(valid).toBe(false);
  });

  it('shows server errors inline, and leaves other errors to the page', () => {
    publish([field({ fieldKey: 'a' })]);
    const { result } = renderHook(() => useCustomFieldForm('products'));
    const api = { response: { data: { error: { code: 'CUSTOM_FIELDS_INVALID', details: [{ path: 'customFields.a', message: 'Nope' }] } } } };
    let handled = false;
    act(() => { handled = result.current.showApiErrors(api); });
    expect(handled).toBe(true);
    expect(result.current.errors).toEqual({ a: 'Nope' });
    act(() => result.current.setValue('a', 'fixed'));
    expect(result.current.errors).toEqual({});
    expect(result.current.showApiErrors(new Error('other'))).toBe(false);
  });
});

describe('CustomFieldsSection', () => {
  it('renders nothing when the module has no fields', () => {
    const { container } = render(<Form />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders and edits every field type', async () => {
    publish([
      field({ fieldKey: 'txt', label: 'Text', sortOrder: 1 }),
      field({ fieldKey: 'num', label: 'Number', fieldType: 'number', sortOrder: 2 }),
      field({ fieldKey: 'day', label: 'Date', fieldType: 'date', sortOrder: 3 }),
      field({ fieldKey: 'yes', label: 'Flag', fieldType: 'boolean', sortOrder: 4 }),
      field({ fieldKey: 'one', label: 'One', fieldType: 'select', options: [{ value: 'a', label: 'Alpha' }], sortOrder: 5 }),
      field({ fieldKey: 'many', label: 'Many', fieldType: 'multiselect', options: [{ value: 'x', label: 'Ex' }, { value: 'y', label: 'Why' }], sortOrder: 6 }),
    ]);
    const u = userEvent.setup();
    const payloads: unknown[] = [];
    function Probe() {
      const form = useCustomFieldForm('products');
      payloads.push(form.payload());
      return <CustomFieldsSection form={form} />;
    }
    render(<Probe />);

    expect(screen.getByRole('region', { name: 'Additional fields' })).toBeInTheDocument();
    await u.type(screen.getByLabelText('Text'), 'hi');
    await u.type(screen.getByLabelText('Number'), '4.5');
    await u.type(screen.getByLabelText('Date'), '2026-02-28');
    await u.click(screen.getByRole('switch', { name: 'Flag' }));
    await u.click(screen.getByRole('combobox', { name: 'One' }));
    await u.click(await screen.findByRole('option', { name: 'Alpha' }));
    await u.click(screen.getByRole('checkbox', { name: 'Why' }));

    expect(payloads.at(-1)).toEqual({ customFields: { txt: 'hi', num: 4.5, day: '2026-02-28', yes: true, one: 'a', many: ['y'] } });
  });

  it('read-only fields are disabled, required ones are marked, errors sit beside the field', () => {
    render(
      <CustomFieldsSection
        form={{
          fields: [field({ fieldKey: 'ro', label: 'Locked', writable: false }), field({ fieldKey: 'req', label: 'Needed', required: true })],
          values: {},
          errors: { req: 'Needed is required' },
          setValue: () => undefined,
        }}
      />,
    );
    expect(screen.getByLabelText('Locked')).toBeDisabled();
    const needed = screen.getByLabelText('Needed *');
    expect(needed).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Needed is required');
  });

  it('archived options are offered only while the record holds them', () => {
    const many = field({ fieldKey: 'm', label: 'Many', fieldType: 'multiselect', options: [{ value: 'a', label: 'Active' }, { value: 'old', label: 'Retired', archived: true }] });
    const form = (values: Record<string, unknown>) => ({ fields: [many], values, errors: {}, setValue: () => undefined });
    const { rerender } = render(<CustomFieldsSection form={form({})} />);
    expect(screen.queryByRole('checkbox', { name: 'Retired' })).not.toBeInTheDocument();
    rerender(<CustomFieldsSection form={form({ m: ['old'] })} />);
    expect(screen.getByRole('checkbox', { name: 'Retired' })).toBeChecked();
  });

  it('a detail view lists stored values and skips empty ones', () => {
    const { container, rerender } = render(<CustomFieldValuesList fields={[field({ fieldKey: 'a', label: 'A' })]} values={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CustomFieldValuesList fields={[field({ fieldKey: 'a', label: 'A' }), field({ fieldKey: 'b', label: 'B' })]} values={{ a: 'x' }} />);
    expect(screen.getByText('x')).toBeInTheDocument();
    expect(screen.queryByText('B')).not.toBeInTheDocument();
  });
});

describe('row normalizers keep custom field values', () => {
  it('normalizeProduct passes them through', async () => {
    const { normalizeProduct } = await import('@/hooks/use-products');
    expect(normalizeProduct({ id: 'p', customFields: { grade: 'a' } }).customFields).toEqual({ grade: 'a' });
    expect(normalizeProduct({ id: 'p' }).customFields).toBeNull();
  });
});

describe('CustomFieldFilters', () => {
  it('builds the list parameter from set values only', () => {
    expect(customFieldFilterParam({})).toBeUndefined();
    expect(customFieldFilterParam({ a: null, b: '' })).toBeUndefined();
    expect(customFieldFilterParam({ a: 'x', b: null, c: 0, d: false })).toBe('{"a":"x","c":0,"d":false}');
  });

  it('shows only searchable fields, and nothing when there are none', () => {
    const { container, rerender } = render(<CustomFieldFilters fields={[field({ fieldKey: 'a' })]} values={{}} onChange={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CustomFieldFilters fields={[field({ fieldKey: 'a', label: 'A' }), field({ fieldKey: 'b', label: 'B', searchable: true })]} values={{}} onChange={() => undefined} />);
    expect(screen.getByLabelText('Filter by B')).toBeInTheDocument();
    expect(screen.queryByLabelText('Filter by A')).not.toBeInTheDocument();
  });

  it('a choice filter sets and clears, and booleans stay booleans', async () => {
    const onChange = vi.fn();
    const u = userEvent.setup();
    render(<CustomFieldFilters fields={[field({ fieldKey: 'flag', label: 'Flag', fieldType: 'boolean', searchable: true })]} values={{}} onChange={onChange} />);
    await u.click(screen.getByRole('combobox', { name: 'Filter by Flag' }));
    await u.click(await screen.findByRole('option', { name: 'No' }));
    expect(onChange).toHaveBeenLastCalledWith('flag', false);
  });

  it('a number filter sends a number after typing pauses', async () => {
    const onChange = vi.fn();
    const u = userEvent.setup();
    render(<CustomFieldFilters fields={[field({ fieldKey: 'n', label: 'N', fieldType: 'number', searchable: true })]} values={{}} onChange={onChange} />);
    await u.type(screen.getByLabelText('Filter by N'), '42');
    expect(onChange).not.toHaveBeenCalledWith('n', 4);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('n', 42));
  });
});

describe('tables without the shared column system', () => {
  it('heads and cells line up, showing a dash for empty values', () => {
    const fields = [field({ fieldKey: 'grade', label: 'Grade', fieldType: 'select', options: [{ value: 'a', label: 'Grade A' }] }), field({ fieldKey: 'note', label: 'Note' })];
    render(
      <table>
        <thead><tr><CustomFieldHeads fields={fields} /></tr></thead>
        <tbody><tr><CustomFieldCells fields={fields} values={{ grade: 'a' }} /></tr></tbody>
      </table>,
    );
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Grade', 'Note']);
    expect(screen.getAllByRole('cell').map((c) => c.textContent)).toEqual(['Grade A', '—']);
  });

  it('adds nothing with no fields, so existing tables are unchanged', () => {
    render(<table><thead><tr><CustomFieldHeads fields={[]} /></tr></thead></table>);
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
  });
});

describe('useCustomFieldFilters', () => {
  it('builds the list parameter as filters change, and tells the page to go back to page one', () => {
    publish([field({ fieldKey: 'a', searchable: true })]);
    const onChanged = vi.fn();
    const { result } = renderHook(() => useCustomFieldFilters('products', onChanged));
    expect(result.current.param).toBeUndefined();
    act(() => result.current.change('a', 'x'));
    expect(result.current.param).toBe('{"a":"x"}');
    expect(onChanged).toHaveBeenCalledTimes(1);
    act(() => result.current.change('a', null));
    expect(result.current.param).toBeUndefined();
  });
});
