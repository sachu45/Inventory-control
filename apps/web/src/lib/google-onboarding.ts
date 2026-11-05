import { api } from '@/api/client';

export async function startGoogleOnboarding(args: { plan?: 'pro' | 'plus'; billing?: 'monthly' | 'yearly'; loginOnly?: boolean }) {
  const configuration = await api.get('/auth/onboarding/configuration');
  const config = configuration.data?.data ?? configuration.data;
  if (!config.available) throw new Error(config.message || 'Google signup is not configured.');
  const response = await api.post('/auth/onboarding/intent', args);
  const data = response.data?.data ?? response.data;
  const url = new URL(data.authorizationUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') throw new Error('Unexpected authentication destination.');
  window.location.assign(url.href);
}
