import { compileSnapshot, customFieldDraftsFromSnapshot, diffSnapshots } from './config-snapshot';
import {
  CUSTOM_FIELD_MODULES,
  CUSTOM_FIELD_TABLES,
  createCustomFieldSchema,
  customFieldIssues,
  removedOptionValues,
  updateCustomFieldSchema,
} from './custom-fields';

const base = { moduleKey: 'products', fieldKey: 'grade', fieldType: 'text' };
const messages = (field: Parameters<typeof customFieldIssues>[0]) => customFieldIssues(field).map((i) => i.path);
const draft = (over: Record<string, unknown> = {}) => ({
  ...base,
  label: 'Grade',
  required: false,
  searchable: false,
  readRoles: [],
  writeRoles: [],
  sortOrder: 0,
  ...over,
});

describe('custom field schemas', () => {
  it('every supporting module has a value table, and no others', () => {
    expect([...CUSTOM_FIELD_MODULES].sort()).toEqual(Object.keys(CUSTOM_FIELD_TABLES).sort());
  });

  it.each(['a', '1abc', 'Abc', 'has-dash', 'has space', `a${'b'.repeat(40)}`])('rejects field key %s', (fieldKey) => {
    expect(createCustomFieldSchema.safeParse({ ...base, label: 'L', fieldKey }).success).toBe(false);
  });

  it('accepts a well formed field key and refuses unknown properties and roles', () => {
    expect(createCustomFieldSchema.safeParse({ ...base, label: 'L' }).success).toBe(true);
    expect(createCustomFieldSchema.safeParse({ ...base, label: 'L', extra: 1 }).success).toBe(false);
    expect(createCustomFieldSchema.safeParse({ ...base, label: 'L', readRoles: ['NOT_A_ROLE'] }).success).toBe(false);
    expect(createCustomFieldSchema.safeParse({ ...base, label: 'L', validation: { evil: 1 } }).success).toBe(false);
  });

  it('does not coerce: the string "false" is not a boolean', () => {
    expect(updateCustomFieldSchema.safeParse({ required: 'false' }).success).toBe(false);
  });

  it('update has no way to change the identity of a field', () => {
    expect(updateCustomFieldSchema.safeParse({ fieldKey: 'other' }).success).toBe(false);
    expect(updateCustomFieldSchema.safeParse({ moduleKey: 'suppliers' }).success).toBe(false);
  });
});

describe('customFieldIssues', () => {
  it('accepts a valid field of each kind', () => {
    expect(messages(base)).toEqual([]);
    expect(messages({ ...base, fieldType: 'number', validation: { min: 0, max: 5 }, defaultValue: 3 })).toEqual([]);
    expect(messages({ ...base, fieldType: 'date', defaultValue: '2026-02-28' })).toEqual([]);
    expect(messages({ ...base, fieldType: 'boolean', defaultValue: false })).toEqual([]);
    const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', archived: true }];
    expect(messages({ ...base, fieldType: 'select', options, defaultValue: 'a' })).toEqual([]);
    expect(messages({ ...base, fieldType: 'multiselect', options, defaultValue: ['a'] })).toEqual([]);
  });

  it('refuses modules that are unknown or have nowhere to store values', () => {
    expect(messages({ ...base, moduleKey: 'nope' })).toEqual(['moduleKey']);
    expect(messages({ ...base, moduleKey: 'rfqs' })).toEqual(['moduleKey']);
    expect(messages({ ...base, moduleKey: 'settings' })).toEqual(['moduleKey']);
  });

  it('options must suit the type and be unique', () => {
    expect(messages({ ...base, fieldType: 'select' })).toEqual(['options']);
    expect(messages({ ...base, options: [{ value: 'a', label: 'A' }] })).toEqual(['options']);
    expect(messages({ ...base, fieldType: 'select', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] })).toEqual(['options']);
  });

  it('validation rules must suit the type', () => {
    expect(messages({ ...base, validation: { min: 1 } })).toEqual(['validation']);
    expect(messages({ ...base, fieldType: 'number', validation: { min: 5, max: 1 } })).toEqual(['validation']);
    expect(messages({ ...base, fieldType: 'number', validation: { pattern: 'a' } })).toEqual(['validation']);
    expect(messages({ ...base, validation: { pattern: '(' } })).toEqual(['validation.pattern']);
  });

  it.each([
    ['text', 5],
    ['number', '5'],
    ['boolean', 'true'],
    ['date', '2026-02-30'],
    ['date', '28/02/2026'],
  ])('a %s field refuses the default %j', (fieldType, defaultValue) => {
    expect(messages({ ...base, fieldType, defaultValue })).toEqual(['defaultValue']);
  });

  it('the default must be an active option', () => {
    const options = [{ value: 'a', label: 'A' }, { value: 'old', label: 'Old', archived: true }];
    expect(messages({ ...base, fieldType: 'select', options, defaultValue: 'old' })).toEqual(['defaultValue']);
    expect(messages({ ...base, fieldType: 'multiselect', options, defaultValue: ['a', 'zzz'] })).toEqual(['defaultValue']);
  });
});

describe('removedOptionValues', () => {
  it('finds options an update dropped; archiving one is not removing it', () => {
    const before = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
    expect(removedOptionValues(before, [{ value: 'a', label: 'A' }])).toEqual(['b']);
    expect(removedOptionValues(before, [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', archived: true }])).toEqual([]);
    expect(removedOptionValues(null, [{ value: 'a', label: 'A' }])).toEqual([]);
  });
});

describe('custom fields in the config snapshot', () => {
  const compile = (fields: ReturnType<typeof draft>[]) => compileSnapshot([], new Set(), 1, fields);

  it('with no fields, a snapshot differs from defaults in nothing', () => {
    const { snapshot, issues } = compile([]);
    expect(issues).toEqual([]);
    expect(snapshot.customFields).toEqual({});
    expect(diffSnapshots(null, snapshot)).toEqual([]);
  });

  it('groups fields by module in display order and leaves out empty parts', () => {
    const { snapshot } = compile([
      draft({ fieldKey: 'later', sortOrder: 2, options: null, validation: null, defaultValue: null }),
      draft({ fieldKey: 'first', sortOrder: 1 }),
      draft({ fieldKey: 'phone', moduleKey: 'suppliers' }),
    ]);
    expect(snapshot.customFields?.products?.map((f) => f.fieldKey)).toEqual(['first', 'later']);
    expect(snapshot.customFields?.suppliers?.map((f) => f.fieldKey)).toEqual(['phone']);
    expect(Object.keys(snapshot.customFields?.products?.[1] ?? {})).not.toEqual(expect.arrayContaining(['options', 'validation', 'defaultValue']));
  });

  it('reports invalid fields as publish issues, by path', () => {
    const { issues, snapshot } = compile([draft({ fieldType: 'select' })]);
    expect(issues).toEqual([expect.objectContaining({ path: 'customFields.products.grade.options' })]);
    expect(snapshot.customFields).toEqual({});
  });

  it('shows a new field in the diff', () => {
    const { snapshot } = compile([draft()]);
    expect(diffSnapshots(null, snapshot).map((c) => c.path)).toEqual(['customFields.products']);
  });

  it('versions published before custom fields read as having none', () => {
    const { snapshot } = compile([]);
    const { customFields: _none, ...old } = snapshot;
    expect(customFieldDraftsFromSnapshot(old)).toEqual([]);
    expect(diffSnapshots(old, old)).toEqual([]);
  });

  it('round-trips through a snapshot unchanged, as a rollback needs', () => {
    const { snapshot } = compile([draft({ fieldType: 'select', options: [{ value: 'a', label: 'A' }], defaultValue: 'a' })]);
    const again = compileSnapshot([], new Set(), 2, customFieldDraftsFromSnapshot(snapshot));
    expect(again.issues).toEqual([]);
    expect(again.snapshot.customFields).toEqual(snapshot.customFields);
  });
});
