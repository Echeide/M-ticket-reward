import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  adminCollectionRewardClaimView,
  claimCollectionMilestones,
  dailyCollectionRankingQuery,
  ticketUserSummaryQuery,
} from '../src/index';
import { compilePostgresQuery } from '../src/platform/db';
import type { DbClient } from '../src/platform/db';

function migratedDatabase() {
  const database = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations-d1').filter((name) => name.endsWith('.sql')).sort()) {
    database.exec(readFileSync(`migrations-d1/${file}`, 'utf8'));
  }
  database.exec(`
    INSERT INTO external_users
      (id, rtales_subject, rtales_lookup_code, rtales_lookup_code_normalized, display_name, space_code, installation_id)
    VALUES ('user-1', 'subject-1', 'PLAYER01', 'PLAYER01', 'Jugador', 'GCX26', 'installation-1');
    INSERT INTO player_sessions
      (id, access_token_hash, user_ref, rtales_game_session_id, player_token_encrypted, expires_at,
       external_user_id, rtales_lookup_code, space_code, installation_id)
    VALUES ('session-1', 'hash-1', 'subject-1', 'game-1', 'token', '2099-01-01 00:00:00',
      'user-1', 'PLAYER01', 'GCX26', 'installation-1');
    INSERT INTO stores (id, code, name) VALUES ('store-1', 'HIPERDINO', 'Hiperdino');
    INSERT INTO receipts
      (id, public_id, session_id, user_ref, image_key, image_sha256, image_content_type, image_size,
       status, store_id, total_cents, points_awarded, external_user_id, created_at)
    VALUES ('receipt-1', 'TKT-ONE', 'session-1', 'subject-1', 'image-1', 'sha-1', 'image/jpeg', 100,
      'REWARDED', 'store-1', 7500, 25, 'user-1', '2026-08-26 12:00:00');
    INSERT INTO collection_reward_claims
      (id, store_id, external_user_id, rule_type, rule_key, period_key, installation_id, family_id,
       requested_card_id, status, idempotency_key, awarded_card_ids, delivered_at)
    VALUES ('claim-daily', 'store-1', 'user-1', 'DAILY_WINNER', 'CATEGORY:HIPERDINO', '2026-08-26',
      'installation-1', 'family-1', 'card-1', 'DELIVERED', 'claim-daily-key', '["card-1"]', '2026-08-27 01:00:00');
    INSERT INTO collection_reward_claims
      (id, store_id, external_user_id, receipt_id, rule_type, rule_key, installation_id, family_id,
       requested_card_id, status, idempotency_key, last_error)
    VALUES ('claim-failed', 'store-1', 'user-1', 'receipt-1', 'MILESTONE', '100',
      'installation-1', 'family-1', 'card-2', 'FAILED', 'claim-failed-key', 'RTALES_TIMEOUT');
  `);
  return database;
}

function userRows(database: DatabaseSync, url: URL) {
  const query = ticketUserSummaryQuery(url, 6);
  const compiled = compilePostgresQuery(query.sql, query.values);
  const bindings = sqliteBindings(compiled.bindings);
  return database.prepare(compiled.statement).all(...bindings) as Array<Record<string, unknown>>;
}

function sqliteBindings(bindings: Array<string | number | ArrayBuffer | null>) {
  return bindings.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
}

test('user summaries count only delivered cards and identify daily prizes', () => {
  const database = migratedDatabase();
  const rows = userRows(database, new URL('https://example.test/api/admin/ticket-users'));

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.cards_awarded, 1);
  assert.equal(rows[0]!.daily_cards_awarded, 1);
});

test('daily card filters use the rewarded period and installation', () => {
  const database = migratedDatabase();
  const matching = userRows(database, new URL('https://example.test/api/admin/ticket-users?collection=DAILY&cardFrom=2026-08-26&cardTo=2026-08-26&installation=installation-1'));
  const outside = userRows(database, new URL('https://example.test/api/admin/ticket-users?collection=DAILY&cardFrom=2026-08-27'));

  assert.equal(matching.length, 1);
  assert.equal(outside.length, 0);
});

test('daily card rankings exclude purchases from another Rtales installation', () => {
  const database = migratedDatabase();
  database.exec(`
    INSERT INTO external_users
      (id, rtales_subject, rtales_lookup_code, rtales_lookup_code_normalized, display_name, space_code, installation_id)
    VALUES ('user-2', 'subject-2', 'PLAYER02', 'PLAYER02', 'Otro jugador', 'OTHER', 'installation-2');
    INSERT INTO player_sessions
      (id, access_token_hash, user_ref, rtales_game_session_id, player_token_encrypted, expires_at,
       external_user_id, rtales_lookup_code, space_code, installation_id)
    VALUES ('session-2', 'hash-2', 'subject-2', 'game-2', 'token', '2099-01-01 00:00:00',
      'user-2', 'PLAYER02', 'OTHER', 'installation-2');
    INSERT INTO receipts
      (id, public_id, session_id, user_ref, image_key, image_sha256, image_content_type, image_size,
       status, store_id, total_cents, points_awarded, external_user_id, created_at)
    VALUES ('receipt-2', 'TKT-TWO', 'session-2', 'subject-2', 'image-2', 'sha-2', 'image/jpeg', 100,
      'REWARDED', 'store-1', 15000, 100, 'user-2', '2026-08-26 13:00:00');
  `);
  const query = dailyCollectionRankingQuery({
    storeIds: ['store-1'], startAt: '2026-08-26 00:00:00', endAt: '2026-08-27 00:00:00',
    installationId: 'installation-1', minimumPurchases: 1, metric: 'POINTS',
  });
  const compiled = compilePostgresQuery(query.sql, query.values);
  const rows = database.prepare(compiled.statement).all(...sqliteBindings(compiled.bindings)) as Array<Record<string, unknown>>;

  assert.deepEqual(rows.map((row) => row.external_user_id), ['user-1']);
});

test('collection milestones cannot cross Rtales installations', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client: DbClient = {
    async query<T>(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes('FROM stores')) return { rows: [{
        id: 'store-1',
        collection_config: {
          enabled: true, installationId: 'installation-1', familyId: 'family-1',
          milestones: [{ points: 25, cardId: 'card-1' }],
        },
      }] as T[], rowCount: 1 };
      if (sql.includes('AS installation_id')) {
        return { rows: [{ installation_id: 'installation-2' }] as T[], rowCount: 1 };
      }
      throw new Error('Unexpected query after installation mismatch');
    },
  };

  const claims = await claimCollectionMilestones(client, {
    id: 'receipt-1', store_id: 'store-1', external_user_id: 'user-1',
  });

  assert.deepEqual(claims, []);
  assert.equal(calls.length, 2);
});

test('collection reward audit view preserves delivery and failure evidence', () => {
  const view = adminCollectionRewardClaimView({
    id: 'claim-1', store_id: 'store-1', external_user_id: 'user-1', receipt_id: null,
    rule_type: 'DAILY_WINNER', rule_key: 'CATEGORY:HIPERDINO', period_key: '2026-08-26',
    installation_id: 'installation-1', family_id: 'family-1', requested_card_id: 'card-1',
    status: 'DELIVERED', idempotency_key: 'key-1', rtales_result_id: 'result-1',
    rtales_reversal_id: null, awarded_card_ids: ['card-1'], attempt_count: 1, last_error: null,
    created_at: '2026-08-27 01:00:00', delivered_at: '2026-08-27 01:00:01', revoked_at: null,
    store_name: 'Hiperdino', store_code: 'HIPERDINO', receipt_public_id: null,
  });

  assert.equal(view.ruleType, 'DAILY_WINNER');
  assert.equal(view.periodKey, '2026-08-26');
  assert.deepEqual(view.awardedCardIds, ['card-1']);
  assert.equal(view.status, 'DELIVERED');
});
