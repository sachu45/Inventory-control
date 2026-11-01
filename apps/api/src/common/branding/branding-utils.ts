import type { BrandingSnapshotV1 } from './branding.types';
import type { Prisma } from '@prisma/client';

const STOP_WORDS = new Set([
  'the',
  'of',
  'and',
  'private',
  'pvt',
  'ltd',
  'limited',
  'inc',
  'llc',
]);

export function computeCompanyInitials(name: string | null | undefined): string {
  const raw = (name ?? '').trim();
  if (!raw) return 'NA';
  const parts = raw
    .split(/[\s,]+/)
    .map((part) => part.replace(/[^a-zA-Z0-9]/g, '').toLowerCase())
    .filter(Boolean)
    .filter((part) => !STOP_WORDS.has(part));
  const letters = parts.length > 0 ? parts : raw.split(/\s+/);
  const first = letters[0]?.[0] ?? 'N';
  const second = letters[1]?.[0] ?? (letters[0]?.[1] ?? 'A');
  return `${String(first).toUpperCase()}${String(second).toUpperCase()}`;
}

export function asBrandingSnapshot(
  value: Prisma.JsonValue | null | undefined,
): BrandingSnapshotV1 {
  if (!value) {
    throw new Error('Cannot cast null/undefined to BrandingSnapshotV1');
  }
  return value as BrandingSnapshotV1;
}

export function asBrandingSnapshotOrNull(
  value: Prisma.JsonValue | null | undefined,
): BrandingSnapshotV1 | null {
  if (!value) return null;
  return value as BrandingSnapshotV1;
}
