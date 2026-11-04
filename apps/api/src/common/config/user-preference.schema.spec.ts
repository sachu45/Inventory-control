import { HttpStatus } from '@nestjs/common';
import {
  InvalidPreferencesException,
  applyMandatoryColumns,
  parseUserPreferences,
} from './user-preference.schema';

describe('parseUserPreferences', () => {
  it('accepts every allowed preference key', () => {
    const prefs = {
      columnOrder: ['sku', 'name'],
      hiddenColumns: ['notes'],
      defaultSort: { field: 'name', direction: 'asc' },
      defaultFilters: { status: ['OPEN', 'DRAFT'], shopId: 'abc', archived: false },
      pinned: ['sales'],
      order: ['sales', 'inventory'],
    };
    expect(parseUserPreferences(prefs)).toEqual(prefs);
  });

  it('accepts an empty object', () => {
    expect(parseUserPreferences({})).toEqual({});
  });

  it('rejects unknown keys with a 422 naming them', () => {
    const attempt = () => parseUserPreferences({ hiddenColumns: [], enabled: false, mandatory: ['x'] });
    expect(attempt).toThrow(InvalidPreferencesException);
    try {
      attempt();
    } catch (err) {
      const e = err as InvalidPreferencesException;
      expect(e.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(JSON.stringify(e.details)).toMatch(/enabled/);
      expect(JSON.stringify(e.details)).toMatch(/mandatory/);
    }
  });

  it('rejects unknown keys nested in defaultSort', () => {
    expect(() =>
      parseUserPreferences({ defaultSort: { field: 'name', direction: 'asc', locked: true } }),
    ).toThrow(InvalidPreferencesException);
  });

  it('rejects wrong value types', () => {
    expect(() => parseUserPreferences({ hiddenColumns: 'notes' })).toThrow(InvalidPreferencesException);
    expect(() => parseUserPreferences({ defaultSort: { field: 'name', direction: 'up' } })).toThrow(
      InvalidPreferencesException,
    );
    expect(() => parseUserPreferences({ defaultFilters: { status: { nested: true } } })).toThrow(
      InvalidPreferencesException,
    );
  });

  it('rejects non-object input', () => {
    expect(() => parseUserPreferences(null)).toThrow(InvalidPreferencesException);
    expect(() => parseUserPreferences(['hiddenColumns'])).toThrow(InvalidPreferencesException);
  });
});

describe('applyMandatoryColumns', () => {
  it('drops hidden columns that the business config makes mandatory', () => {
    const prefs = { hiddenColumns: ['notes', 'gstin', 'discount'], pinned: ['sales'] };
    expect(applyMandatoryColumns(prefs, new Set(['gstin']))).toEqual({
      hiddenColumns: ['notes', 'discount'],
      pinned: ['sales'],
    });
  });

  it('leaves preferences untouched when nothing mandatory is hidden', () => {
    const prefs = { hiddenColumns: ['notes'] };
    expect(applyMandatoryColumns(prefs, new Set(['gstin']))).toEqual(prefs);
    expect(applyMandatoryColumns({}, new Set(['gstin']))).toEqual({});
  });

  it('does not mutate the stored preferences', () => {
    const prefs = { hiddenColumns: ['gstin'] };
    applyMandatoryColumns(prefs, new Set(['gstin']));
    expect(prefs.hiddenColumns).toEqual(['gstin']);
  });
});
