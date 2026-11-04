import type { JsonSchema, ModuleSettings } from '@/lib/platform-api';

const input = 'w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none';

const humanize = (key: string) =>
  key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/**
 * Renders a form for any module settings schema (JSON Schema from the API), so a
 * setting added to a module's configSchema in code is editable with no new UI.
 * The server validates on save; this only shapes the input.
 */
export function SchemaForm({
  schema,
  value,
  onChange,
  only,
  locked = [],
  idPrefix,
}: {
  schema: JsonSchema;
  value: ModuleSettings;
  onChange: (next: ModuleSettings) => void;
  /** Restrict to these keys (shop overrides may only touch shopOverridable keys). */
  only?: string[];
  /** Field names the platform always requires; shown, never offered as hideable. */
  locked?: string[];
  idPrefix: string;
}) {
  const entries = Object.entries(schema.properties ?? {}).filter(([key]) => !only || only.includes(key));
  if (entries.length === 0) return <p className="text-sm text-slate-500">No settings to edit here.</p>;

  const set = (key: string, next: unknown) => onChange({ ...value, [key]: next });

  return (
    <div className="space-y-4">
      {entries.map(([key, prop]) => {
        const id = `${idPrefix}-${key}`;
        const label = prop.description ?? humanize(key);
        const current = value[key];

        if (prop.type === 'array' && prop.items) {
          const options = (prop.items.enum ?? []) as string[];
          if (options.length === 0) {
            return (
              <Field key={key} label={label}>
                <p className="text-sm text-slate-500">No fields can be customized for this module yet.</p>
              </Field>
            );
          }
          const selected = new Set(Array.isArray(current) ? (current as string[]) : []);
          return (
            <Field key={key} label={label}>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {options.map((option) => (
                  <label key={option} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.has(option)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(option);
                        else next.delete(option);
                        set(key, options.filter((o) => next.has(o)));
                      }}
                    />
                    {humanize(option)}
                  </label>
                ))}
              </div>
              {locked.length > 0 && key.toLowerCase().includes('hidden') && (
                <p className="mt-1 text-xs text-slate-500">Always required (platform-locked): {locked.map(humanize).join(', ')}</p>
              )}
            </Field>
          );
        }

        if (prop.type === 'string' && prop.enum) {
          return (
            <Field key={key} label={label} htmlFor={id}>
              <select id={id} className={input} value={(current as string) ?? ''} onChange={(e) => set(key, e.target.value || undefined)}>
                <option value="">—</option>
                {(prop.enum as string[]).map((option) => (
                  <option key={option} value={option}>
                    {humanize(option)}
                  </option>
                ))}
              </select>
            </Field>
          );
        }

        if (prop.type === 'string') {
          return (
            <Field key={key} label={label} htmlFor={id}>
              <input
                id={id}
                className={input}
                value={(current as string) ?? ''}
                maxLength={prop.maxLength}
                placeholder={schema.required?.includes(key) ? undefined : 'Not set'}
                onChange={(e) => set(key, e.target.value === '' ? undefined : e.target.value)}
              />
            </Field>
          );
        }

        if (prop.type === 'number' || prop.type === 'integer') {
          return (
            <Field key={key} label={label} htmlFor={id}>
              <input
                id={id}
                type="number"
                className={input}
                min={prop.minimum}
                max={prop.maximum}
                step={prop.type === 'integer' ? 1 : 'any'}
                value={typeof current === 'number' ? current : ''}
                onChange={(e) => set(key, e.target.value === '' ? undefined : Number(e.target.value))}
              />
            </Field>
          );
        }

        if (prop.type === 'boolean') {
          return (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={current === true} onChange={(e) => set(key, e.target.checked)} />
              {label}
            </label>
          );
        }

        return (
          <Field key={key} label={label}>
            <p className="text-sm text-amber-700">This setting type is not editable in the console yet.</p>
          </Field>
        );
      })}
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </label>
      {children}
    </div>
  );
}
