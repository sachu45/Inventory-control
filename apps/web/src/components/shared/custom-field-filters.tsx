import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CustomField, CustomFieldValues } from '@/lib/custom-fields';

const ANY = '__any__';

/** The `cf` list parameter for these filters, or undefined when none is set. */
export function customFieldFilterParam(values: CustomFieldValues): string | undefined {
  const set = Object.entries(values).filter(([, value]) => value !== '' && value !== null && value !== undefined);
  return set.length ? JSON.stringify(Object.fromEntries(set)) : undefined;
}

function TextFilter({ field, value, onChange }: { field: CustomField; value: unknown; onChange: (value: unknown) => void }) {
  const isNumber = field.fieldType === 'number';
  const [text, setText] = useState(value === undefined || value === null ? '' : String(value));

  // Filters match exactly, so wait for a pause in typing rather than querying each keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = text.trim();
      const next = trimmed === '' ? null : isNumber ? Number(trimmed) : trimmed;
      if (next !== (value ?? null)) onChange(next);
    }, 400);
    return () => clearTimeout(timer);
  }, [text, isNumber, value, onChange]);

  return (
    <Input
      aria-label={`Filter by ${field.label}`}
      className="w-full sm:w-40"
      type={isNumber ? 'number' : field.fieldType === 'date' ? 'date' : 'text'}
      step="any"
      placeholder={field.label}
      value={text}
      onChange={(e) => setText(e.target.value)}
    />
  );
}

function ChoiceFilter({ field, value, onChange }: { field: CustomField; value: unknown; onChange: (value: unknown) => void }) {
  const isBoolean = field.fieldType === 'boolean';
  const options = isBoolean
    ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
    : (field.options ?? []);
  return (
    <Select
      value={value === undefined || value === null ? ANY : String(value)}
      onValueChange={(next) => {
        if (next === ANY) onChange(null);
        else onChange(isBoolean ? next === 'true' : next);
      }}
    >
      <SelectTrigger aria-label={`Filter by ${field.label}`} className="w-full sm:w-40">
        <SelectValue placeholder={field.label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{`Any ${field.label}`}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** List filters for a module's searchable custom fields. Renders nothing when it has none. */
export function CustomFieldFilters({
  fields,
  values,
  onChange,
}: {
  fields: CustomField[];
  values: CustomFieldValues;
  onChange: (key: string, value: unknown) => void;
}) {
  const searchable = fields.filter((field) => field.searchable);
  if (!searchable.length) return null;
  return (
    <>
      {searchable.map((field) => {
        const change = (value: unknown) => onChange(field.fieldKey, value);
        const value = values[field.fieldKey];
        const isChoice = field.fieldType === 'boolean' || field.fieldType === 'select' || field.fieldType === 'multiselect';
        return isChoice ? (
          <ChoiceFilter key={field.fieldKey} field={field} value={value} onChange={change} />
        ) : (
          <TextFilter key={field.fieldKey} field={field} value={value} onChange={change} />
        );
      })}
    </>
  );
}
