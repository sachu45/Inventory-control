import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import { fetchMeConfig, type CachedMeConfig, type MeConfig } from './me-config';

const config: MeConfig = { version: 3, modules: {}, sidebar: [], preferences: {} };

describe('fetchMeConfig', () => {
  const get = vi.spyOn(api, 'get');
  beforeEach(() => get.mockReset());

  it('unwraps the response envelope and keeps the ETag', async () => {
    get.mockResolvedValue({ status: 200, data: { success: true, data: config }, headers: { etag: '"v3"' } });
    await expect(fetchMeConfig('u1', null)).resolves.toEqual({ userId: 'u1', etag: '"v3"', data: config });
    expect(get.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it('revalidates with the stored ETag and keeps the stored config on 304', async () => {
    const previous: CachedMeConfig = { userId: 'u1', etag: '"v3"', data: config };
    get.mockResolvedValue({ status: 304, data: '', headers: {} });
    await expect(fetchMeConfig('u1', previous)).resolves.toBe(previous);
    expect(get.mock.calls[0][1]?.headers).toEqual({ 'If-None-Match': '"v3"' });
  });

  it("never sends another user's ETag", async () => {
    get.mockResolvedValue({ status: 200, data: { data: config }, headers: {} });
    await fetchMeConfig('u2', { userId: 'u1', etag: '"v3"', data: config });
    expect(get.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it('throws on an unexpected body so the caller falls back', async () => {
    get.mockResolvedValue({ status: 200, data: { data: { nope: true } }, headers: {} });
    await expect(fetchMeConfig('u1', null)).rejects.toThrow();
  });
});
