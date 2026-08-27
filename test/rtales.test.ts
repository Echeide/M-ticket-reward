import assert from 'node:assert/strict';
import test from 'node:test';
import {
  grantStablePlayerReward,
  grantTicketPoints,
  loadRtalesRewardCatalog,
  retryAfterSeconds,
  RtalesTransportError,
} from '../src/integrations/rtales';
import type { Env } from '../src/types';

function rtalesEnv(overrides: Partial<Env> = {}): Env {
  return {
    RTALES_BASE_URL: 'https://rtales.example',
    RTALES_EXTERNAL_GAME_TOKEN: 'secret',
    RTALES_PARENT_ORIGINS: 'https://example.com',
    RTALES_TIMEOUT_MS: '1000',
    ...overrides,
  } as Env;
}

const request = {
  gameSessionId: 'session-1',
  playerToken: 'player-token',
  receiptId: 'receipt-1',
  publicId: 'TKT-TEST',
  points: 10,
  totalCents: 5000,
  idempotencyKey: 'reward:receipt-1',
};

test('Rtales requests include timeout and idempotency protection', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get('idempotency-key'), request.idempotencyKey);
    return Response.json({ success: true, result: { id: 'result-1' } });
  };

  const result = await grantTicketPoints(rtalesEnv(), request);
  assert.equal(result.payload.success, true);
});

test('Rtales collection catalog is loaded without a request body', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/api/integrations/external-games/reward-catalog');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    return Response.json({ success: true, installations: [] });
  };
  const result = await loadRtalesRewardCatalog(rtalesEnv());
  assert.equal(result.payload.success, true);
});

test('stable collection rewards identify the player without an open web session', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.playerSubject, 'rtps_player');
    assert.equal(body.playerLookupCode, 'ABCD1234');
    assert.equal(body.familyId, 'family-1');
    assert.deepEqual(body.cardIds, ['card-1']);
    assert.equal(body.points, 0);
    return Response.json({ success: true, result: { id: 'result-card-1' } });
  };
  const result = await grantStablePlayerReward(rtalesEnv(), {
    installationId: 'installation-1',
    playerSubject: 'rtps_player',
    playerLookupCode: 'ABCD1234',
    familyId: 'family-1',
    externalMatchId: 'claim-1',
    eventType: 'TICKET_COLLECTION_MILESTONE',
    cardId: 'card-1',
    idempotencyKey: 'claim-1',
  });
  assert.equal(result.payload.success, true);
});

test('Rtales timeouts become retryable transport errors', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    throw new DOMException('The operation timed out', 'TimeoutError');
  };

  await assert.rejects(
    grantTicketPoints(rtalesEnv(), request),
    (caught: unknown) => caught instanceof RtalesTransportError && caught.code === 'RTALES_TIMEOUT',
  );
});

test('Retry-After accepts seconds and HTTP dates', () => {
  assert.equal(retryAfterSeconds(new Response(null, { headers: { 'Retry-After': '45' } })), 45);
  const now = Date.UTC(2026, 7, 6, 12, 0, 0);
  const later = new Date(now + 90_000).toUTCString();
  assert.equal(retryAfterSeconds(new Response(null, { headers: { 'Retry-After': later } }), now), 90);
});
