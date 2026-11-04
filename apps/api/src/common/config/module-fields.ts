import { HttpException, HttpStatus } from '@nestjs/common';
import type { ResolvedConfig } from './config-resolver.service';
import { MODULE_REGISTRY, ModuleKey } from './module-registry';

/**
 * Customizable fields that live on each document line (`items[]`) rather than
 * on the document itself. Every other customizable field is a top-level field.
 * Field names match the module's DTOs and Prisma models.
 */
export const LINE_FIELDS: Partial<Record<ModuleKey, readonly string[]>> = {
  'purchase-orders': ['lineDescription', 'lineCategory'],
};

const LINES_KEY = 'items';

export type FieldPolicy = {
  /** Fields the company made mandatory (locked mandatory fields are required by the DTO itself). */
  mandatory: string[];
  hidden: string[];
};

export type FieldIssue = { path: string; message: string };

export class MandatoryFieldsException extends HttpException {
  constructor(public readonly details: FieldIssue[]) {
    super(
      { message: 'Required fields are missing', code: 'MANDATORY_FIELDS_MISSING', details },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export function fieldPolicy(key: ModuleKey, config: Pick<ResolvedConfig, 'modules'>): FieldPolicy {
  const { mandatoryFields, hiddenFields } = config.modules[key].config;
  return { mandatory: [...mandatoryFields], hidden: [...hiddenFields] };
}

function isLineField(key: ModuleKey, field: string): boolean {
  return LINE_FIELDS[key]?.includes(field) ?? false;
}

function isMissing(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Applies the policy to a create/update body in place: hidden fields are
 * dropped (ignored on write), and missing mandatory fields are returned as issues.
 * On update a top-level field is only checked when the request sends it, and
 * line fields only when the request sends lines.
 */
export function applyWritePolicy(
  key: ModuleKey,
  policy: FieldPolicy,
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): FieldIssue[] {
  const lines = Array.isArray(body[LINES_KEY]) ? (body[LINES_KEY] as unknown[]).filter(isRecord) : [];

  for (const field of policy.hidden) {
    if (isLineField(key, field)) for (const line of lines) delete line[field];
    else delete body[field];
  }

  const issues: FieldIssue[] = [];
  const label = MODULE_REGISTRY[key].label;
  for (const field of policy.mandatory) {
    if (isLineField(key, field)) {
      lines.forEach((line, index) => {
        if (isMissing(line[field])) {
          issues.push({ path: `${LINES_KEY}.${index}.${field}`, message: `${field} is required for every line in ${label}` });
        }
      });
    } else if ((mode === 'create' || field in body) && isMissing(body[field])) {
      issues.push({ path: field, message: `${field} is required in ${label}` });
    }
  }
  return issues;
}

const ENVELOPE_KEYS = new Set(['success', 'data', 'meta', 'message']);

/**
 * Removes hidden fields from a response: a document, a list of documents, or a
 * `{ data, meta }` page of them, including their `items[]` lines. Values that
 * are not plain objects or arrays (files, streams, buffers) pass through untouched.
 */
export function redactHidden<T>(key: ModuleKey, policy: FieldPolicy, value: T): T {
  if (!policy.hidden.length) return value;
  const header = policy.hidden.filter((field) => !isLineField(key, field));
  const line = policy.hidden.filter((field) => isLineField(key, field));

  const redactDocument = (doc: unknown): unknown => {
    if (!isPlain(doc)) return doc;
    const copy: Record<string, unknown> = { ...doc };
    for (const field of header) delete copy[field];
    if (line.length && Array.isArray(copy[LINES_KEY])) {
      copy[LINES_KEY] = (copy[LINES_KEY] as unknown[]).map((item) => {
        if (!isPlain(item)) return item;
        const lineCopy = { ...item };
        for (const field of line) delete lineCopy[field];
        return lineCopy;
      });
    }
    return copy;
  };

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(redactDocument);
    if (isPlain(node) && 'data' in node && Object.keys(node).every((k) => ENVELOPE_KEYS.has(k))) {
      return { ...node, data: walk(node.data) };
    }
    return redactDocument(node);
  };
  return walk(value) as T;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}
