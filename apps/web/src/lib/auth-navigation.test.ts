import { describe, expect, it } from 'vitest';
import { signInDestination } from './auth-navigation';
describe('post-login navigation', () => {
  it('returns users to the requested local record', () => {
    expect(signInDestination('/products?record=p1#details', '/dashboard')).toBe('/products?record=p1#details');
  });
  it.each(['https://external.example', '//external.example', '/\\external.example', 'javascript:alert(1)', '/login', '/sales\n'])('rejects unsafe or looping destinations: %s', from => {
    expect(signInDestination(from, '/dashboard')).toBe('/dashboard');
  });
});
