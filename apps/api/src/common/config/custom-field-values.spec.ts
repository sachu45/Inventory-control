import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { CUSTOM_FIELDS_WRITE_KEY, redactCustomFields, resolveCustomFieldWrite } from './custom-field-values';
import { CUSTOM_FIELD_TABLES, type CustomFieldSnapshot, customFieldIssues } from './custom-fields';
import { REQUIRES_MODULE_KEY } from './requires-module.decorator';

const field = (over: Partial<CustomFieldSnapshot> & { fieldKey: string }): CustomFieldSnapshot => ({
  label: over.fieldKey,
  fieldType: 'text',
  required: false,
  searchable: false,
  readRoles: [],
  writeRoles: [],
  sortOrder: 0,
  ...over,
});

const write = (fields: CustomFieldSnapshot[], submitted: unknown, opts: { stored?: unknown; role?: string; mode?: 'create' | 'update' } = {}) =>
  resolveCustomFieldWrite({ fields, submitted, stored: opts.stored ?? null, role: opts.role ?? 'OWNER', mode: opts.mode ?? 'create' });
const paths = (result: { issues: { path: string }[] }) => result.issues.map((i) => i.path);

describe('resolveCustomFieldWrite', () => {
  it('leaves the column alone when nothing is defined or sent', () => {
    expect(write([], undefined)).toEqual({ issues: [] });
    expect(write([field({ fieldKey: 'a' })], undefined, { mode: 'update', stored: { a: 'x' } })).toEqual({ issues: [] });
  });

  it('rejects unknown and non-object input, naming the path', () => {
    expect(paths(write([], { nope: 1 }))).toEqual(['customFields.nope']);
    expect(paths(write([field({ fieldKey: 'a' })], { a: 'ok', nope: 1 }))).toEqual(['customFields.nope']);
    for (const bad of ['x', 5, ['a'], null]) expect(paths(write([], bad))).toEqual(['customFields']);
  });

  it.each([
    ['text', 5],
    ['number', '5'],
    ['number', Infinity],
    ['boolean', 'true'],
    ['boolean', 0],
    ['date', '2026-02-30'],
    ['date', '05/11/2026'],
  ] as const)('a %s field refuses %j, with no coercion', (fieldType, value) => {
    expect(paths(write([field({ fieldKey: 'a', fieldType })], { a: value }))).toEqual(['customFields.a']);
  });

  it.each([
    ['text', 'hello'],
    ['number', 0],
    ['boolean', false],
    ['date', '2026-02-28'],
  ] as const)('a %s field accepts %j', (fieldType, value) => {
    expect(write([field({ fieldKey: 'a', fieldType })], { a: value })).toEqual({ issues: [], values: { a: value } });
  });

  it('applies validation rules', () => {
    const num = field({ fieldKey: 'n', fieldType: 'number', validation: { min: 1, max: 5 } });
    expect(paths(write([num], { n: 0 }))).toEqual(['customFields.n']);
    expect(paths(write([num], { n: 6 }))).toEqual(['customFields.n']);
    expect(paths(write([num], { n: 5 }))).toEqual([]);
    const text = field({ fieldKey: 't', validation: { maxLength: 3, pattern: '^[A-Z]+$' } });
    expect(paths(write([text], { t: 'ABCD' }))).toEqual(['customFields.t']);
    expect(paths(write([text], { t: 'ab' }))).toEqual(['customFields.t']);
    expect(paths(write([text], { t: 'ABC' }))).toEqual([]);
    expect(paths(write([field({ fieldKey: 't' })], { t: 'x'.repeat(10_001) }))).toEqual(['customFields.t']);
  });

  it('select values must be active options; a held archived option may be resent', () => {
    const options = [{ value: 'a', label: 'A' }, { value: 'old', label: 'Old', archived: true }];
    const select = field({ fieldKey: 's', fieldType: 'select', options });
    expect(paths(write([select], { s: 'a' }))).toEqual([]);
    expect(paths(write([select], { s: 'zzz' }))).toEqual(['customFields.s']);
    expect(paths(write([select], { s: 'old' }))).toEqual(['customFields.s']);
    expect(paths(write([select], { s: 'old' }, { mode: 'update', stored: { s: 'old' } }))).toEqual([]);

    const multi = field({ fieldKey: 'm', fieldType: 'multiselect', options });
    expect(paths(write([multi], { m: ['a'] }))).toEqual([]);
    expect(paths(write([multi], { m: 'a' }))).toEqual(['customFields.m']);
    expect(paths(write([multi], { m: ['a', 'a'] }))).toEqual(['customFields.m']);
    expect(paths(write([multi], { m: ['a', 'old'] }))).toEqual(['customFields.m']);
    expect(paths(write([multi], { m: ['a', 'old'] }, { mode: 'update', stored: { m: ['old'] } }))).toEqual([]);
  });

  it('an update merges: values this request does not name are kept, including archived and hidden ones', () => {
    const fields = [field({ fieldKey: 'a' }), field({ fieldKey: 'secret', readRoles: ['OWNER'], writeRoles: ['OWNER'] })];
    const result = write(fields, { a: 'new' }, { mode: 'update', role: 'SALES', stored: { a: 'old', secret: 's', archived_one: 1 } });
    expect(result.values).toEqual({ a: 'new', secret: 's', archived_one: 1 });
  });

  it('empty values clear a field', () => {
    const fields = [field({ fieldKey: 'a' }), field({ fieldKey: 'b', fieldType: 'multiselect', options: [{ value: 'x', label: 'X' }] })];
    for (const empty of [null, '']) {
      expect(write(fields, { a: empty }, { mode: 'update', stored: { a: 'old', b: ['x'] } }).values).toEqual({ b: ['x'] });
    }
    expect(write(fields, { b: [] }, { mode: 'update', stored: { b: ['x'] } }).values).toEqual({});
  });

  it('refuses a write by a role not in writeRoles', () => {
    const restricted = field({ fieldKey: 'a', writeRoles: ['OWNER', 'ADMIN'] });
    expect(paths(write([restricted], { a: 'x' }, { role: 'SALES' }))).toEqual(['customFields.a']);
    expect(paths(write([restricted], { a: 'x' }, { role: 'ADMIN' }))).toEqual([]);
  });

  it('required applies to new and edited records, unless this role cannot write the field', () => {
    const required = field({ fieldKey: 'a', required: true });
    expect(paths(write([required], undefined))).toEqual(['customFields.a']);
    expect(paths(write([required], { a: 'x' }))).toEqual([]);
    expect(paths(write([required], undefined, { mode: 'update' }))).toEqual(['customFields.a']);
    expect(paths(write([required], undefined, { mode: 'update', stored: { a: 'x' } }))).toEqual([]);
    expect(paths(write([required], { a: null }, { mode: 'update', stored: { a: 'x' } }))).toEqual(['customFields.a']);
    const ownerOnly = field({ fieldKey: 'a', required: true, writeRoles: ['OWNER'] });
    expect(paths(write([ownerOnly], undefined, { role: 'SALES' }))).toEqual([]);
  });

  it('defaults fill new records only, and an explicit empty value wins over them', () => {
    const withDefault = field({ fieldKey: 'a', defaultValue: 'd' });
    expect(write([withDefault], undefined).values).toEqual({ a: 'd' });
    expect(write([withDefault], { a: 'x' }).values).toEqual({ a: 'x' });
    expect(write([withDefault], { a: null }).values).toEqual({});
    expect(write([withDefault], undefined, { mode: 'update' })).toEqual({ issues: [] });
    expect(paths(write([field({ fieldKey: 'a', required: true, defaultValue: 'd' })], undefined))).toEqual([]);
  });
});

describe('redactCustomFields', () => {
  const fields = [field({ fieldKey: 'open' }), field({ fieldKey: 'cost', readRoles: ['OWNER'] })];
  const values = { open: 1, cost: 2, archived_one: 3 };

  it('keeps only published fields this role may read on a record', () => {
    expect(redactCustomFields({ id: 'p', customFields: values }, fields, 'SALES')).toEqual({ id: 'p', customFields: { open: 1 } });
    expect(redactCustomFields({ id: 'p', customFields: values }, fields, 'OWNER')).toEqual({ id: 'p', customFields: { open: 1, cost: 2 } });
    expect(redactCustomFields({ id: 'p', customFields: null }, fields, 'SALES')).toEqual({ id: 'p', customFields: null });
  });

  it.each([
    ['a list', [{ id: 'p', customFields: values }]],
    ['a page', { data: [{ id: 'p', customFields: values }], meta: { total: 1 } }],
    ['named items', { items: [{ id: 'p', customFields: values }], nextCursor: null }],
  ])('finds records in %s', (_name, response) => {
    expect(JSON.stringify(redactCustomFields(response, fields, 'SALES'))).not.toContain('cost');
    expect(JSON.stringify(redactCustomFields(response, fields, 'SALES'))).toContain('"open":1');
  });

  it('removes values nested under a record: they belong to another module', () => {
    const po = { id: 'po', customFields: { open: 1 }, supplier: { id: 's', customFields: { open: 9, cost: 9 } }, items: [{ product: { customFields: { cost: 9 } } }] };
    const out = redactCustomFields(po, fields, 'OWNER');
    expect(out.customFields).toEqual({ open: 1 });
    expect(out.supplier).toEqual({ id: 's' });
    expect(out.items).toEqual([{ product: {} }]);
  });

  it('removes all values on routes of no value-holding module', () => {
    expect(redactCustomFields({ id: 's', product: { id: 'p', customFields: values }, customFields: values }, null, 'OWNER')).toEqual({ id: 's', product: { id: 'p' } });
  });

  it('leaves everything else untouched, including dates, buffers and class instances', () => {
    class Decimal { value = 1; }
    const when = new Date(0);
    const buffer = Buffer.from('x');
    const decimal = new Decimal();
    const out = redactCustomFields({ id: 'a', when, buffer, decimal, nothing: null, list: [1, 'x'] }, null, '');
    expect(out).toEqual({ id: 'a', when, buffer, decimal, nothing: null, list: [1, 'x'] });
    expect(out.when).toBe(when);
    expect(out.decimal).toBe(decimal);
    expect(redactCustomFields('text', null, '')).toBe('text');
    expect(redactCustomFields(undefined, null, '')).toBeUndefined();
  });
});

describe('pattern safety', () => {
  const issue = (pattern: string) => customFieldIssues({ moduleKey: 'products', fieldKey: 'aa', fieldType: 'text', validation: { pattern } }).map((i) => i.path);

  it.each(['(a+)+', '(a*)*', '(a+){2,}', '([a-z]+)*$', '^(x+)+y'])('refuses %s, which can backtrack catastrophically', (pattern) => {
    expect(issue(pattern)).toEqual(['validation.pattern']);
  });

  it.each(['^[A-Z]{2}-\\d{4}$', '^(foo|bar)$', '^(ab)+$', 'a+b*'])('accepts %s', (pattern) => {
    expect(issue(pattern)).toEqual([]);
  });
});

describe('custom field write routes', () => {
  function controllerFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return controllerFiles(path);
      return name.endsWith('.controller.ts') ? [path] : [];
    });
  }

  it('every value-holding module marks its create and update routes, so none can skip validation', () => {
    const found = new Map<string, { create: number; update: number; unmarked: string[] }>();
    for (const file of controllerFiles(join(__dirname, '..', '..'))) {
      for (const cls of Object.values(require(file) as Record<string, unknown>)) {
        if (typeof cls !== 'function' || Reflect.getMetadata(PATH_METADATA, cls) === undefined) continue;
        const key = Reflect.getMetadata(REQUIRES_MODULE_KEY, cls) as string | undefined;
        // Tagged products for access, but it edits barcodes rather than product records.
        if (!key || !(key in CUSTOM_FIELD_TABLES) || cls.name === 'BarcodesController') continue;
        const entry = found.get(key) ?? { create: 0, update: 0, unmarked: [] };
        const proto = cls.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = proto[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
          const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
          const mode = Reflect.getMetadata(CUSTOM_FIELDS_WRITE_KEY, handler) as string | undefined;
          if (mode === 'create') entry.create += 1;
          if (mode === 'update') entry.update += 1;
          const plainWrite = (method === RequestMethod.POST && path === '/') || (method === RequestMethod.PATCH && path === ':id');
          if (plainWrite && !mode) entry.unmarked.push(`${cls.name}.${name}`);
        }
        found.set(key, entry);
      }
    }
    expect([...found.keys()].sort()).toEqual(Object.keys(CUSTOM_FIELD_TABLES).sort());
    for (const [key, entry] of found) {
      expect({ key, create: entry.create, unmarked: entry.unmarked }).toEqual({ key, create: 1, unmarked: [] });
      expect(entry.update).toBe(key === 'invoices' ? 0 : 1);
    }
  });
});
