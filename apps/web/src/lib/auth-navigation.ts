/** Only local workspace paths are valid post-login destinations. */
export function signInDestination(from: string | null | undefined, fallback: string): string {
  if (!from?.startsWith('/') || from.startsWith('//') || from.includes('\\') || from.includes('\r') || from.includes('\n')) return fallback;
  const target = new URL(from, 'https://workspace.invalid');
  if (target.origin !== 'https://workspace.invalid' || target.pathname.startsWith('/login')) return fallback;
  return target.pathname + target.search + target.hash;
}
