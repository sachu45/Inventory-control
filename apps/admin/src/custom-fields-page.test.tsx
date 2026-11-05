import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, AxiosHeaders } from 'axios';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBody, emptyForm, formFromField, movedSortOrders, updateBody } from './lib/custom-field-editing';
import { configApi, customFieldApi, type CustomFieldDefinition, type DraftModule } from './lib/platform-api';
import { CustomFieldsPage } from './pages/config/CustomFieldsPage';

const moduleOf = (key: string, label: string, supportsCustomFields: boolean) => ({ key, label, supportsCustomFields }) as DraftModule;
const field = (over: Partial<CustomFieldDefinition> & { id: string; fieldKey: string }): CustomFieldDefinition => ({
  moduleKey: 'products',
  label: over.fieldKey,
  fieldType: 'text',
  options: null,
  validation: null,
  required: false,
  defaultValue: null,
  searchable: false,
  readRoles: [],
  writeRoles: [],
  sortOrder: 0,
  archivedAt: null,
  ...over,
});

function apiError(status: number, error: { code: string; message: string; details?: unknown }) {
  const err = new AxiosError('failed', String(status));
  err.response = { status, data: { success: false, error }, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } };
  return err;
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/tenants/c1/custom-fields']}>
        <Routes>
          <Route path="/tenants/:companyId/custom-fields" element={<CustomFieldsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(configApi, 'listDrafts').mockResolvedValue([
    moduleOf('settings', 'Settings', false),
    moduleOf('products', 'Products', true),
    moduleOf('suppliers', 'Suppliers', true),
  ]);
  vi.spyOn(customFieldApi, 'list').mockResolvedValue([]);
});

describe('custom field editing helpers', () => {
  it('builds a create body suited to the type, leaving out rules that do not apply', () => {
    const number = { ...emptyForm('products'), fieldKey: ' weight ', label: ' Weight ', fieldType: 'number' as const, min: '0', max: '9', maxLength: '5', pattern: 'x', defaultValue: '3' };
    expect(createBody(number, 10)).toEqual({
      moduleKey: 'products', fieldKey: 'weight', sortOrder: 10, label: 'Weight', fieldType: 'number', options: null,
      validation: { min: 0, max: 9 }, required: false, defaultValue: 3, searchable: false, readRoles: [], writeRoles: [],
    });
    const text = { ...emptyForm('products'), fieldType: 'text' as const, min: '0', maxLength: '5', pattern: '^A' };
    expect(createBody(text, 0).validation).toEqual({ maxLength: 5, pattern: '^A' });
    expect(createBody(emptyForm('products'), 0).validation).toBeNull();
    expect(createBody({ ...emptyForm('products'), fieldType: 'boolean', defaultValue: 'false' }, 0).defaultValue).toBe(false);
    expect(createBody({ ...emptyForm('products'), fieldType: 'multiselect', defaultValue: 'a, b,' }, 0).defaultValue).toEqual(['a', 'b']);
  });

  it('sends requiredRollout only when turning required on', () => {
    const off = field({ id: '1', fieldKey: 'a' });
    const on = field({ id: '1', fieldKey: 'a', required: true });
    expect(updateBody({ ...formFromField(off), required: true }, off)).toMatchObject({ required: true, requiredRollout: 'new_and_edited' });
    expect(updateBody(formFromField(on), on)).not.toHaveProperty('requiredRollout');
    expect(updateBody({ ...formFromField(on), required: false }, on)).not.toHaveProperty('requiredRollout');
  });

  it('round-trips a saved field through the form', () => {
    const saved = field({ id: '1', fieldKey: 'a', fieldType: 'multiselect', options: [{ value: 'x', label: 'X' }], defaultValue: ['x'], readRoles: ['OWNER'] });
    const body = updateBody(formFromField(saved), saved);
    expect(body).toMatchObject({ fieldType: 'multiselect', options: [{ value: 'x', label: 'X' }], defaultValue: ['x'], readRoles: ['OWNER'] });
  });

  it('moves swap two fields, spreading ties first so the move always takes effect', () => {
    const fields = [field({ id: 'a', fieldKey: 'a', sortOrder: 0 }), field({ id: 'b', fieldKey: 'b', sortOrder: 10 }), field({ id: 'c', fieldKey: 'c', sortOrder: 20 })];
    expect(movedSortOrders(fields, 'b', -1)).toEqual([{ id: 'a', sortOrder: 10 }, { id: 'b', sortOrder: 0 }]);
    expect(movedSortOrders(fields, 'a', -1)).toEqual([]);
    expect(movedSortOrders(fields, 'c', 1)).toEqual([]);
    const tied = fields.map((f) => ({ ...f, sortOrder: 0 }));
    expect(movedSortOrders(tied, 'b', 1)).toEqual([{ id: 'b', sortOrder: 20 }, { id: 'c', sortOrder: 10 }]);
  });
});

describe('CustomFieldsPage', () => {
  it('offers only modules that support custom fields', async () => {
    renderPage();
    const select = await screen.findByLabelText('Module');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Products', 'Suppliers']);
    expect(screen.getByText('No custom fields in this module yet.')).toBeInTheDocument();
  });

  it('creates a choice field with options, and says it is a draft', async () => {
    const create = vi.spyOn(customFieldApi, 'create').mockResolvedValue(field({ id: 'n', fieldKey: 'grade' }));
    const u = userEvent.setup();
    renderPage();
    await u.click(await screen.findByRole('button', { name: 'Add field' }));
    const form = screen.getByRole('form', { name: 'New custom field' });
    await u.type(within(form).getByLabelText('Label'), 'Grade');
    await u.type(within(form).getByLabelText(/^Key/), 'grade');
    await u.selectOptions(within(form).getByLabelText(/^Type/), 'select');
    await u.click(within(form).getByRole('button', { name: 'Add option' }));
    await u.type(within(form).getByLabelText('Option 1 value'), 'a');
    await u.type(within(form).getByLabelText('Option 1 label'), 'Grade A');
    await u.click(within(form).getByRole('button', { name: 'Add field' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][1]).toMatchObject({ moduleKey: 'products', fieldKey: 'grade', label: 'Grade', fieldType: 'select', options: [{ value: 'a', label: 'Grade A' }] });
    expect(await screen.findByRole('status')).toHaveTextContent('Publish to make it live');
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });

  it('shows the lifecycle limits when editing: key locked, saved options archive rather than remove', async () => {
    vi.mocked(customFieldApi.list).mockResolvedValue([
      field({ id: '1', fieldKey: 'grade', label: 'Grade', fieldType: 'select', options: [{ value: 'a', label: 'A' }] }),
    ]);
    const update = vi.spyOn(customFieldApi, 'update').mockResolvedValue(field({ id: '1', fieldKey: 'grade' }));
    const u = userEvent.setup();
    renderPage();
    await u.click(await screen.findByRole('button', { name: 'Edit Grade' }));
    const form = screen.getByRole('form', { name: 'Edit Grade' });

    expect(within(form).getByLabelText(/^Key/)).toBeDisabled();
    expect(within(form).getByText(/A key cannot change/)).toBeInTheDocument();
    expect(within(form).getByLabelText('Option 1 value')).toBeDisabled();
    expect(within(form).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();

    // A new, unsaved option can be removed again.
    await u.click(within(form).getByRole('button', { name: 'Add option' }));
    await u.click(within(form).getByRole('button', { name: 'Remove' }));

    await u.click(within(form).getByRole('checkbox', { name: 'Archived' }));
    await u.click(within(form).getByRole('checkbox', { name: 'Required' }));
    expect(within(form).getByRole('note')).toHaveTextContent('new and edited records');
    await u.click(within(form).getByRole('button', { name: 'Save field' }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][2]).toMatchObject({ options: [{ value: 'a', label: 'A', archived: true }], required: true, requiredRollout: 'new_and_edited' });
    expect(update.mock.calls[0][2]).not.toHaveProperty('fieldKey');
  });

  it('shows why the API refused, keeping the form and what was typed', async () => {
    vi.mocked(customFieldApi.list).mockResolvedValue([field({ id: '1', fieldKey: 'weight', label: 'Weight' })]);
    vi.spyOn(customFieldApi, 'update').mockRejectedValue(
      apiError(409, { code: 'CUSTOM_FIELD_TYPE_LOCKED', message: 'The type cannot change once records hold a value for this field; create a new field instead' }),
    );
    const u = userEvent.setup();
    renderPage();
    await u.click(await screen.findByRole('button', { name: 'Edit Weight' }));
    const form = screen.getByRole('form', { name: 'Edit Weight' });
    await u.selectOptions(within(form).getByLabelText(/^Type/), 'number');
    await u.click(within(form).getByRole('button', { name: 'Save field' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The type cannot change');
    expect(within(screen.getByRole('form', { name: 'Edit Weight' })).getByLabelText(/^Type/)).toHaveValue('number');
  });

  it('lists validation problems by field', async () => {
    vi.spyOn(customFieldApi, 'create').mockRejectedValue(
      apiError(422, { code: 'CONFIG_INVALID', message: 'Invalid configuration', details: [{ path: 'validation.pattern', message: 'Not a valid regular expression' }] }),
    );
    const u = userEvent.setup();
    renderPage();
    await u.click(await screen.findByRole('button', { name: 'Add field' }));
    const form = screen.getByRole('form', { name: 'New custom field' });
    await u.type(within(form).getByLabelText('Label'), 'L');
    await u.type(within(form).getByLabelText(/^Key/), 'll');
    await u.click(within(form).getByRole('button', { name: 'Add field' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('validation.pattern: Not a valid regular expression');
  });

  it('reorders, archives and restores; archived fields are listed apart and there is no delete', async () => {
    vi.mocked(customFieldApi.list).mockResolvedValue([
      field({ id: '1', fieldKey: 'first', label: 'First', sortOrder: 0 }),
      field({ id: '2', fieldKey: 'second', label: 'Second', sortOrder: 10 }),
      field({ id: '3', fieldKey: 'old', label: 'Old', archivedAt: '2026-01-01T00:00:00Z' }),
    ]);
    const update = vi.spyOn(customFieldApi, 'update').mockResolvedValue(field({ id: '1', fieldKey: 'first' }));
    const setArchived = vi.spyOn(customFieldApi, 'setArchived').mockResolvedValue(field({ id: '1', fieldKey: 'first' }));
    const u = userEvent.setup();
    renderPage();

    const list = await screen.findByRole('list', { name: 'Custom fields' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('First'), expect.stringContaining('Second')]);
    expect(within(screen.getByRole('list', { name: 'Archived fields' })).getByText(/Old/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move First up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Second down' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Move Second up' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenCalledWith('c1', '1', { sortOrder: 10 });
    expect(update).toHaveBeenCalledWith('c1', '2', { sortOrder: 0 });

    await u.click(await screen.findByRole('button', { name: 'Archive First' }));
    await waitFor(() => expect(setArchived).toHaveBeenCalledWith('c1', '1', true));
    await u.click(await screen.findByRole('button', { name: 'Restore Old' }));
    await waitFor(() => expect(setArchived).toHaveBeenCalledWith('c1', '3', false));
  });

  it('switching module shows that module\'s fields and adds to it', async () => {
    vi.mocked(customFieldApi.list).mockResolvedValue([
      field({ id: '1', fieldKey: 'prod', label: 'Product field' }),
      field({ id: '2', fieldKey: 'supp', label: 'Supplier field', moduleKey: 'suppliers' }),
    ]);
    const create = vi.spyOn(customFieldApi, 'create').mockResolvedValue(field({ id: 'n', fieldKey: 'x' }));
    const u = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Product field')).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Module'), 'suppliers');
    expect(screen.queryByText('Product field')).not.toBeInTheDocument();
    expect(screen.getByText('Supplier field')).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Add field' }));
    const form = screen.getByRole('form', { name: 'New custom field' });
    await u.type(within(form).getByLabelText('Label'), 'L');
    await u.type(within(form).getByLabelText(/^Key/), 'll');
    await u.click(within(form).getByRole('button', { name: 'Add field' }));
    await waitFor(() => expect(create.mock.calls[0][1]).toMatchObject({ moduleKey: 'suppliers' }));
  });
});
