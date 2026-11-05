import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { CustomFieldForm } from '@/hooks/use-custom-fields';
import { formatCustomFieldValue, type CustomField } from '@/lib/custom-fields';

const NO_VALUE = '__none__';

function FieldControl({
  field,
  id,
  value,
  invalid,
  onChange,
}: {
  field: CustomField;
  id: string;
  value: unknown;
  invalid: boolean;
  onChange: (value: unknown) => void;
}) {
  const disabled = !field.writable;
  const described = { 'aria-invalid': invalid || undefined, 'aria-describedby': invalid ? `${id}-error` : undefined };
  /** Archived options stay listed only while the record holds them, so they aren't offered to anyone new. */
  const options = (held: unknown[]) => (field.options ?? []).filter((o) => !o.archived || held.includes(o.value));

  switch (field.fieldType) {
    case 'boolean':
      return <Switch id={id} checked={value === true} disabled={disabled} onCheckedChange={onChange} {...described} />;
    case 'number':
      return (
        <Input
          id={id}
          type="number"
          step="any"
          value={typeof value === 'number' ? value : ''}
          disabled={disabled}
          min={field.validation?.min}
          max={field.validation?.max}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          {...described}
        />
      );
    case 'date':
      return <Input id={id} type="date" value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} {...described} />;
    case 'select': {
      const current = typeof value === 'string' ? value : '';
      return (
        <Select value={current || NO_VALUE} disabled={disabled} onValueChange={(v) => onChange(v === NO_VALUE ? null : v)}>
          <SelectTrigger id={id} {...described}>
            <SelectValue placeholder="Select" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_VALUE}>None</SelectItem>
            {options([current]).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    case 'multiselect': {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div id={id} role="group" aria-label={field.label} className="space-y-1 rounded-md border p-2" {...described}>
          {options(chosen).map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(option.value)}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...chosen, option.value] : chosen.filter((v) => v !== option.value))}
              />
              {option.label}
            </label>
          ))}
        </div>
      );
    }
    default:
      return (
        <Input
          id={id}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          maxLength={field.validation?.maxLength}
          onChange={(e) => onChange(e.target.value)}
          {...described}
        />
      );
  }
}

/**
 * The "Additional fields" part of a module form. Renders nothing when the module has
 * no custom fields this user may read, so forms look as they always did.
 */
export function CustomFieldsSection({ form }: { form: Pick<CustomFieldForm, 'fields' | 'values' | 'errors' | 'setValue'> }) {
  if (!form.fields.length) return null;
  return (
    <section aria-label="Additional fields" className="space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Additional fields</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {form.fields.map((field) => {
          const id = `custom-field-${field.fieldKey}`;
          const error = form.errors[field.fieldKey];
          return (
            <div key={field.fieldKey} className="space-y-1.5">
              <Label htmlFor={id}>{field.required ? `${field.label} *` : field.label}</Label>
              <FieldControl
                field={field}
                id={id}
                value={form.values[field.fieldKey]}
                invalid={Boolean(error)}
                onChange={(value) => form.setValue(field.fieldKey, value)}
              />
              {error && (
                <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Read-only values for a detail view. Renders nothing when there is nothing to show. */
export function CustomFieldValuesList({ fields, values }: { fields: CustomField[]; values: unknown }) {
  const stored = (values ?? {}) as Record<string, unknown>;
  const shown = fields.map((field) => ({ field, text: formatCustomFieldValue(field, stored[field.fieldKey]) })).filter((row) => row.text);
  if (!shown.length) return null;
  return (
    <dl aria-label="Additional fields" className="grid gap-3 sm:grid-cols-2">
      {shown.map(({ field, text }) => (
        <div key={field.fieldKey}>
          <dt className="text-xs text-muted-foreground">{field.label}</dt>
          <dd className="text-sm font-medium">{text}</dd>
        </div>
      ))}
    </dl>
  );
}
