import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  normalizeConfirmedProductCampaignIds,
  normalizeProductCampaignInput,
  normalizeProductCampaignMatches,
} from '../src/domain/product-campaign';
import {
  claimProductCampaignReward,
  receiptEligibleForProductCampaign,
  type ProductAnalysisReceipt,
  type ProductCampaignRow,
} from '../src/index';
import { compilePostgresQuery, type DbClient } from '../src/platform/db';

function sqliteBindings(bindings: Array<string | number | ArrayBuffer | null>) {
  return bindings.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
}

function migratedDatabase() {
  const database = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations-d1').filter((name) => name.endsWith('.sql')).sort()) {
    database.exec(readFileSync(`migrations-d1/${file}`, 'utf8'));
  }
  return database;
}

function clientFor(database: DatabaseSync): DbClient {
  return {
    async query<T>(sql: string, values: unknown[] = []) {
      const compiled = compilePostgresQuery(sql, values);
      const rows = database.prepare(compiled.statement)
        .all(...sqliteBindings(compiled.bindings)) as T[];
      return { rows, rowCount: rows.length };
    },
  };
}

test('product campaigns normalize merchant-specific aliases and reward configuration', () => {
  const campaign = normalizeProductCampaignInput({
    name: 'Monster · 3 tickets',
    active: true,
    productTerms: ['Monster', ' MONSTER ', 'MNSTR ENERGY'],
    requiredTickets: 3,
    installationId: 'installation-1',
    familyId: 'family-1',
    cardId: 'card-monster',
    startsOn: '2026-09-01',
    endsOn: '2026-12-31',
    maxAwardsTotal: 500,
  });

  assert.deepEqual(campaign.productTerms, ['Monster', 'MNSTR ENERGY']);
  assert.equal(campaign.requiredTickets, 3);
  assert.equal(campaign.cardId, 'card-monster');
});

test('product campaigns reject impossible dates', () => {
  assert.throws(() => normalizeProductCampaignInput({
    name: 'Monster · febrero',
    active: true,
    productTerms: ['Monster'],
    requiredTickets: 3,
    installationId: 'installation-1',
    familyId: 'family-1',
    cardId: 'card-monster',
    startsOn: '2026-02-31',
    endsOn: '',
    maxAwardsTotal: 0,
  }), /PRODUCT_CAMPAIGN_DATE_INVALID/);
});

test('manual product confirmations accept unique campaign UUIDs only', () => {
  assert.deepEqual(normalizeConfirmedProductCampaignIds([
    'd4bbddbf-0989-4e64-86be-7d63b3c9306c',
    'd4bbddbf-0989-4e64-86be-7d63b3c9306c',
  ]), ['d4bbddbf-0989-4e64-86be-7d63b3c9306c']);
  assert.throws(() => normalizeConfirmedProductCampaignIds(['not-a-campaign']),
    /PRODUCT_CAMPAIGN_CONFIRMATION_INVALID/);
});

test('product matches require high confidence and literal configured evidence', () => {
  const campaigns = [{ id: 'campaign-1', productTerms: ['MONSTER ENERGY', 'MNSTR'] }];
  const matched = normalizeProductCampaignMatches({ matches: [{
    campaignId: 'campaign-1', matched: true, confidence: 0.94,
    productText: 'MONSTER ENERGY 500ML', evidenceText: 'MONSTER ENERGY 500ML 1,69',
  }] }, campaigns);
  const unsupported = normalizeProductCampaignMatches({ matches: [{
    campaignId: 'campaign-1', matched: true, confidence: 0.99,
    productText: 'BEBIDA ENERGETICA', evidenceText: 'BEBIDA ENERGETICA 1,69',
  }] }, campaigns);
  const uncertain = normalizeProductCampaignMatches({ matches: [{
    campaignId: 'campaign-1', matched: true, confidence: 0.70,
    productText: 'MONSTER ENERGY', evidenceText: 'MONSTER ENERGY 1,69',
  }] }, campaigns);

  assert.equal(matched[0]!.matched, true);
  assert.equal(unsupported[0]!.matched, false);
  assert.equal(uncertain[0]!.matched, false);
});

test('valid tickets without points remain eligible for product campaigns', () => {
  assert.equal(receiptEligibleForProductCampaign('REWARDED'), true);
  assert.equal(receiptEligibleForProductCampaign('AUTO_REJECTED', ['USER_DAILY_POINTS_LIMIT']), true);
  assert.equal(receiptEligibleForProductCampaign('AUTO_REJECTED', ['STAFF_FRAUD_CONFIRMED']), false);
  assert.equal(receiptEligibleForProductCampaign('DUPLICATE'), false);
});

test('a product campaign grants one idempotent card after distinct matching tickets', async () => {
  const database = migratedDatabase();
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
    INSERT INTO store_product_campaigns
      (id, store_id, name, product_terms, required_tickets, installation_id,
       family_id, card_id, created_by, activated_at)
    VALUES ('campaign-1', 'store-1', 'Monster', '["MONSTER"]', 2,
      'installation-1', 'family-1', 'card-1', 'admin@example.com', CURRENT_TIMESTAMP);
    INSERT INTO receipts
      (id, public_id, session_id, user_ref, image_key, image_sha256, image_content_type,
       image_size, status, store_id, purchase_date, external_user_id, updated_at)
    VALUES
      ('receipt-1', 'TKT-1', 'session-1', 'subject-1', 'image-1', 'sha-1', 'image/webp',
       100, 'REWARDED', 'store-1', '2026-09-01', 'user-1', '2026-09-01 12:00:00'),
      ('receipt-2', 'TKT-2', 'session-1', 'subject-1', 'image-2', 'sha-2', 'image/webp',
       100, 'REWARDED', 'store-1', '2026-09-02', 'user-1', '2026-09-02 12:00:00');
    INSERT INTO receipt_product_matches
      (receipt_id, campaign_id, external_user_id, status, confidence, evidence_text)
    VALUES ('receipt-1', 'campaign-1', 'user-1', 'MATCHED', 0.95, 'MONSTER 1,69');
  `);
  const client = clientFor(database);
  const campaign = database.prepare('SELECT * FROM store_product_campaigns WHERE id = ?')
    .get('campaign-1') as unknown as ProductCampaignRow;
  campaign.product_terms = JSON.parse(String(campaign.product_terms));
  const receipt = {
    id: 'receipt-2', store_id: 'store-1', external_user_id: 'user-1', image_key: 'image-2',
    image_content_type: 'image/webp', purchase_date: '2026-09-02', status: 'REWARDED',
    validation_reasons: [], eligibility_at: '2026-09-02 12:00:00', installation_id: 'installation-1',
  } satisfies ProductAnalysisReceipt;

  assert.equal(await claimProductCampaignReward(client, campaign, receipt), '');
  database.exec(`INSERT INTO receipt_product_matches
    (receipt_id, campaign_id, external_user_id, status, confidence, evidence_text)
    VALUES ('receipt-2', 'campaign-1', 'user-1', 'MATCHED', 0.96, 'MONSTER 1,79')`);
  assert.ok(await claimProductCampaignReward(client, campaign, receipt));
  assert.equal(await claimProductCampaignReward(client, campaign, receipt), '');
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM collection_reward_claims
    WHERE campaign_id = 'campaign-1'`).get()!.total, 1);
});
