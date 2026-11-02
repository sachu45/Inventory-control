import { describe, expect, it } from 'vitest';
import type { AuthUser } from '@/store/authStore';
import { simpleNavigation, visibleTools, TOOL_GROUPS } from './simple-navigation';

const owner: AuthUser = { id: 'owner', email: 'owner@example.test', name: 'Owner', role: 'OWNER', shopId: null, permissions: [] };
describe('simple navigation access', () => {
  it('keeps every existing tool reachable after reducing the sidebar', () => {
    const reachable = new Set(['/dashboard', ...TOOL_GROUPS.flatMap(group => group.paths)]);
    for (const tool of visibleTools({ ...owner, isPlatformAdmin: true })) expect(reachable.has(tool.path), tool.path).toBe(true);
    expect(simpleNavigation(owner)).toHaveLength(8);
  });
  it('does not expose restricted tools to a warehouse employee', () => {
    const employee: AuthUser = { ...owner, role: 'EMPLOYEE', permissions: ['product:read', 'goods_issue:read'] };
    const paths = visibleTools(employee).map(tool => tool.path);
    expect(paths).toContain('/products');
    expect(paths).toContain('/goods-issues');
    expect(paths).not.toContain('/purchase-orders');
    expect(paths).not.toContain('/reports');
    expect(paths).not.toContain('/platform/subscriptions');
    expect(simpleNavigation(employee).map(link => link.label)).not.toContain('Reports');
  });
  it('keeps platform administration exclusive to platform administrators', () => {
    expect(visibleTools(owner).some(tool => tool.path === '/platform/subscriptions')).toBe(false);
    expect(visibleTools({ ...owner, isPlatformAdmin: true }).some(tool => tool.path === '/platform/subscriptions')).toBe(true);
  });
});
