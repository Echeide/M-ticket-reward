import assert from 'node:assert/strict';
import test from 'node:test';
import { adminInvitationMailConfigured, sendAdminInvitation } from '../src/integrations/mailjet';
import { PENDING_CONFIGURATION_VALUE } from '../src/configuration';
import type { Env } from '../src/types';

const configuredEnv = {
  MAILJET_API_KEY: 'public-key',
  MAILJET_SECRET_KEY: 'secret-key',
  MAILJET_FROM_EMAIL: 'acceso@example.com',
  MAILJET_FROM_NAME: 'Rtales',
} as Env;

test('Mailjet invitation configuration requires both credentials and a sender', () => {
  assert.equal(adminInvitationMailConfigured(configuredEnv), true);
  assert.equal(adminInvitationMailConfigured({ MAILJET_API_KEY: 'key' } as Env), false);
  assert.equal(adminInvitationMailConfigured({
    MAILJET_API_KEY: PENDING_CONFIGURATION_VALUE,
    MAILJET_SECRET_KEY: PENDING_CONFIGURATION_VALUE,
    MAILJET_FROM_EMAIL: PENDING_CONFIGURATION_VALUE,
  } as Env), false);
});

test('administrator invitation is sent server-side with the backoffice link', async () => {
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ Messages: [{ Status: 'success' }] }), { status: 200 });
  };
  try {
    const sent = await sendAdminInvitation(configuredEnv, {
      email: 'admin@example.com', backofficeUrl: 'https://tickets.example.com/backoffice', invitedBy: 'owner@example.com',
    });
    assert.equal(sent, true);
    if (!request) throw new Error('MAILJET_REQUEST_NOT_CAPTURED');
    assert.equal(request?.url, 'https://api.mailjet.com/v3.1/send');
    assert.match(request?.headers.get('authorization') || '', /^Basic /);
    const payload = await request.json() as { Messages: Array<{ To: Array<{ Email: string }>; HTMLPart: string }> };
    assert.equal(payload.Messages[0]!.To[0]!.Email, 'admin@example.com');
    assert.match(payload.Messages[0]!.HTMLPart, /https:\/\/tickets\.example\.com\/backoffice/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invitation is skipped without Mailjet configuration', async () => {
  assert.equal(await sendAdminInvitation({} as Env, {
    email: 'admin@example.com', backofficeUrl: 'https://example.com/backoffice', invitedBy: 'owner@example.com',
  }), false);
});
