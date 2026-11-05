import type { CustomFieldDefinition, CustomFieldOption, CustomFieldType } from './platform-api';

export const FIELD_TYPES: { value: CustomFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'select', label: 'Single choice' },
  { value: 'multiselect', label: 'Multiple choice' },
];

export const ROLES = ['OWNER', 'ADMIN', 'INVENTORY_MANAGER', 'PURCHASE_MANAGER', 'SALES', 'EMPLOYEE', 'WAREHOUSE_STAFF', 'VIEWER', 'VENDOR', 'SHOP_USER'];

/** The form's editable state: inputs hold text until saved, so an invalid number can be seen and fixed. */
export type FieldForm = {
  moduleKey: string;
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options: CustomFieldOption[];
  min: string;
  max: string;
  maxLength: string;
  pattern: string;
  required: boolean;
  defaultValue: string;
  searchable: boolean;
  readRoles: string[];
  writeRoles: string[];
};

export const usesOptions = (type: CustomFieldType) => type === 'select' || type === 'multiselect';

export const emptyForm = (moduleKey: string): FieldForm => ({
  moduleKey,
  fieldKey: '',
  label: '',
  fieldType: 'text',
  options: [],
  min: '',
  max: '',
  maxLength: '',
  pattern: '',
  required: false,
  defaultValue: '',
  searchable: false,
  readRoles: [],
  writeRoles: [],
});

const asText = (value: number | string | undefined) => (value === undefined ? '' : String(value));

function defaultToText(field: CustomFieldDefinition): string {
  const value = field.defaultValue;
  if (value === null || value === undefined) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

export function formFromField(field: CustomFieldDefinition): FieldForm {
  return {
    moduleKey: field.moduleKey,
    fieldKey: field.fieldKey,
    label: field.label,
    fieldType: field.fieldType,
    options: field.options ?? [],
    min: asText(field.validation?.min),
    max: asText(field.validation?.max),
    maxLength: asText(field.validation?.maxLength),
    pattern: field.validation?.pattern ?? '',
    required: field.required,
    defaultValue: defaultToText(field),
    searchable: field.searchable,
    readRoles: field.readRoles,
    writeRoles: field.writeRoles,
  };
}

function parseDefault(form: FieldForm): unknown {
  const text = form.defaultValue.trim();
  if (text === '') return null;
  switch (form.fieldType) {
    case 'number':
      return Number(text);
    case 'boolean':
      return text === 'true';
    case 'multiselect':
      return text.split(',').map((part) => part.trim()).filter(Boolean);
    default:
      return text;
  }
}

function validationFrom(form: FieldForm): Record<string, number | string> | null {
  const rules: Record<string, number | string> = {};
  if (form.fieldType === 'number') {
    if (form.min !== '') rules.min = Number(form.min);
    if (form.max !== '') rules.max = Number(form.max);
  }
  if (form.fieldType === 'text') {
    if (form.maxLength !== '') rules.maxLength = Number(form.maxLength);
    if (form.pattern !== '') rules.pattern = form.pattern;
  }
  return Object.keys(rules).length ? rules : null;
}

/** Everything both create and update send. Rules and options that don't suit the type are left out. */
function editableBody(form: FieldForm) {
  return {
    label: form.label.trim(),
    fieldType: form.fieldType,
    options: usesOptions(form.fieldType) ? form.options : null,
    validation: validationFrom(form),
    required: form.required,
    defaultValue: parseDefault(form),
    searchable: form.searchable,
    readRoles: form.readRoles,
    writeRoles: form.writeRoles,
  };
}

export const createBody = (form: FieldForm, sortOrder: number) => ({
  moduleKey: form.moduleKey,
  fieldKey: form.fieldKey.trim(),
  sortOrder,
  ...editableBody(form),
});

/** `requiredRollout` is sent only when turning required on, which is when the API asks for it. */
export function updateBody(form: FieldForm, saved: CustomFieldDefinition) {
  return {
    ...editableBody(form),
    ...(form.required && !saved.required ? { requiredRollout: 'new_and_edited' as const } : {}),
  };
}

/** Sort orders after moving a field; only the two that swapped are sent. Ties are spread out first. */
export function movedSortOrders(fields: CustomFieldDefinition[], id: string, delta: -1 | 1): { id: string; sortOrder: number }[] {
  const from = fields.findIndex((f) => f.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= fields.length) return [];
  const orders = fields.map((f, index) => ({ id: f.id, was: f.sortOrder, sortOrder: index * 10 }));
  [orders[from].sortOrder, orders[to].sortOrder] = [orders[to].sortOrder, orders[from].sortOrder];
  return orders.filter((o) => o.was !== o.sortOrder).map(({ id: fieldId, sortOrder }) => ({ id: fieldId, sortOrder }));
}

export const byDisplayOrder = (a: CustomFieldDefinition, b: CustomFieldDefinition) =>
  a.sortOrder - b.sortOrder || a.fieldKey.localeCompare(b.fieldKey);
