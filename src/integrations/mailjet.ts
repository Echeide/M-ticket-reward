import type { Env } from '../types';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function adminInvitationMailConfigured(env: Env): boolean {
  return Boolean(env.MAILJET_API_KEY && env.MAILJET_SECRET_KEY && env.MAILJET_FROM_EMAIL);
}

export async function sendAdminInvitation(
  env: Env,
  input: { email: string; backofficeUrl: string; invitedBy: string },
): Promise<boolean> {
  if (!adminInvitationMailConfigured(env)) return false;
  const safeUrl = escapeHtml(input.backofficeUrl);
  const response = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      Messages: [{
        From: { Email: env.MAILJET_FROM_EMAIL, Name: env.MAILJET_FROM_NAME || 'Rtales' },
        To: [{ Email: input.email }],
        Subject: 'Acceso al backoffice de tickets',
        TextPart: `Has sido invitado a administrar el backoffice de tickets. Accede desde: ${input.backofficeUrl}\n\nCloudflare Access verificará tu correo antes de permitir el acceso.`,
        HTMLPart: `<p>Has sido invitado a administrar el backoffice de tickets.</p><p><a href="${safeUrl}">Acceder al backoffice</a></p><p>Cloudflare Access verificará tu correo antes de permitir el acceso.</p>`,
        CustomID: 'admin-backoffice-invitation',
      }],
    }),
  });
  if (!response.ok) throw new Error(`MAILJET_SEND_FAILED:${response.status}`);
  return true;
}
