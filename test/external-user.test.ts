import assert from 'node:assert/strict';
import test from 'node:test';
import {
  externalIdentityFromExchange,
  normalizeLookupCode,
  publicExternalPlayer,
  upsertExternalUser,
  type ExternalUserRow,
} from '../src/domain/external-user';
import type { DbClient, QueryResult } from '../src/platform/db';

const exchange = (subject = 'rtps_maria', displayName = 'María González') => ({
  gameSessionId: 'session-1',
  playerToken: 'rtgp_secret',
  player: {
    subject, lookupCode: 'MARIA-4827', displayName, email: 'Maria@Example.com', language: 'es',
  },
  context: { installationId: 'installation-1', spaceCode: 'gcx26' },
});

class ExternalUserMemoryClient implements DbClient {
  readonly users = new Map<string, ExternalUserRow & Record<string, unknown>>();

  async query<T>(_sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    await Promise.resolve();
    const [id, subject, lookupCode, normalized, displayName, email, language, spaceCode, installationId] = values;
    const key = String(subject);
    const existing = this.users.get(key);
    const row = {
      id: existing?.id || String(id),
      rtales_subject: key,
      rtales_lookup_code: String(lookupCode),
      normalized, displayName, email, language, spaceCode, installationId,
    };
    this.users.set(key, row);
    return { rows: [row as T], rowCount: 1 };
  }
}

test('lookup search normalization ignores case, spaces and hyphens', () => {
  assert.equal(normalizeLookupCode(' maria - 4827 '), 'MARIA4827');
});

test('exchange identity requires Rtales subject, lookup code and context', () => {
  const identity = externalIdentityFromExchange(exchange());
  assert.deepEqual(identity, {
    subject: 'rtps_maria', lookupCode: 'MARIA-4827', displayName: 'María González',
    email: 'maria@example.com', language: 'es', spaceCode: 'GCX26',
    installationId: 'installation-1',
  });
  assert.throws(() => externalIdentityFromExchange({ ...exchange(), player: { lookupCode: 'MARIA-4827' } }),
    /RTALES_PLAYER_SUBJECT_REQUIRED/);
  assert.throws(() => externalIdentityFromExchange({ ...exchange(), player: { subject: 'rtps_maria' } }),
    /RTALES_PLAYER_LOOKUP_CODE_REQUIRED/);
});

test('public session identity never exposes Rtales subjects or tokens', () => {
  const view = publicExternalPlayer(externalIdentityFromExchange(exchange()));
  assert.deepEqual(view, { displayName: 'María González' });
  assert.equal('playerToken' in view, false);
  assert.equal('subject' in view, false);
});

test('repeated upsert uses subject and updates visual identity without duplicates', async () => {
  const client = new ExternalUserMemoryClient();
  const first = await upsertExternalUser(client, externalIdentityFromExchange(exchange()), 'user-1');
  const secondIdentity = externalIdentityFromExchange(exchange('rtps_maria', 'María Nuevo Nombre'));
  secondIdentity.lookupCode = 'MARIA-9999';
  const second = await upsertExternalUser(client, secondIdentity, 'user-2');
  assert.equal(first.id, second.id);
  assert.equal(client.users.size, 1);
  assert.equal(client.users.get('rtps_maria')?.displayName, 'María Nuevo Nombre');
  assert.equal(client.users.get('rtps_maria')?.rtales_lookup_code, 'MARIA-9999');
});

test('equal display names create distinct users when subjects differ', async () => {
  const client = new ExternalUserMemoryClient();
  await upsertExternalUser(client, externalIdentityFromExchange(exchange('rtps_one', 'María')), 'user-1');
  await upsertExternalUser(client, externalIdentityFromExchange(exchange('rtps_two', 'María')), 'user-2');
  assert.equal(client.users.size, 2);
});

test('concurrent upserts converge on one user per subject', async () => {
  const client = new ExternalUserMemoryClient();
  const identity = externalIdentityFromExchange(exchange());
  const users = await Promise.all([
    upsertExternalUser(client, identity, 'user-1'),
    upsertExternalUser(client, identity, 'user-2'),
  ]);
  assert.equal(client.users.size, 1);
  assert.equal(users[0]?.id, users[1]?.id);
});
