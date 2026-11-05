import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Every BullMQ processor runs outside a request, so it must set its tenant
 * context explicitly (#239): `runJobAsCompany` or `TenantContext.run` for one
 * company, or `TenantContext.runWithSystemAccess` for work across tenants. Without it, the
 * query falls back to implicit system access, which strict mode removes.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('background entry points set a TenantContext', () => {
  const src = join(__dirname, '..', '..');
  const processors = sourceFiles(src)
    .map((file) => ({ file: relative(src, file), text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => /extends WorkerHost/.test(text));

  it('finds the processors', () => {
    expect(processors.length).toBeGreaterThanOrEqual(14);
  });

  it('every processor wraps process() in an explicit TenantContext', () => {
    const missing = processors
      .filter(({ text }) => {
        const body = text.slice(text.indexOf('process('), text.indexOf('process(') + 400);
        return !/TenantContext\.(runWithSystemAccess|run)\(|runJobAsCompany\(/.test(body);
      })
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });
});
