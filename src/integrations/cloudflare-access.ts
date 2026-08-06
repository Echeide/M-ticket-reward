import type { Env } from '../types';

export async function syncAdminAccessEmails(env: Env, emails: string[]): Promise<boolean> {
  if (!env.CLOUDFLARE_ACCESS_API_TOKEN || !env.CLOUDFLARE_ACCESS_EMAIL_LIST_ID || !env.CLOUDFLARE_ACCOUNT_ID) {
    return false;
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/gateway/lists/${env.CLOUDFLARE_ACCESS_EMAIL_LIST_ID}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_ACCESS_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: env.CLOUDFLARE_ACCESS_EMAIL_LIST_NAME || 'Ticket rewards administrators',
        description: 'Managed by the ticket rewards backoffice',
        items: emails.map((value) => ({ value, description: 'Backoffice administrator' })),
      }),
    },
  );
  const payload = await response.json() as { success?: boolean; errors?: Array<{ message?: string }> };
  if (!response.ok || !payload.success) {
    throw new Error(`CLOUDFLARE_ACCESS_SYNC_FAILED:${payload.errors?.[0]?.message || response.status}`);
  }
  return true;
}
