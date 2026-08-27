import assert from 'node:assert/strict';
import test from 'node:test';
import type { DbClient } from '../src/platform/db';
import { claimUserRewardPoints, userRewardPointLimitState } from '../src/index';

const settings = {
  'limits.totalPointsPerUser': '100',
  'limits.dailyPointsPerUser': '20',
};

test('point limit totals are read only from the current Rtales installation', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client: DbClient = {
    async query<T>(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT COALESCE(SUM')) {
        return { rows: [{ campaign_total: 12, daily_total: 7 }] as T[], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const state = await userRewardPointLimitState(client, 'user-1', 'installation-a', settings);

  assert.equal(state.campaignUsed, 12);
  assert.equal(state.dailyUsed, 7);
  assert.match(calls[0]!.sql, /COALESCE\(s\.installation_id, ''\) = \$2/);
  assert.equal(calls[0]!.values[1], 'installation-a');
  assert.match(calls[1]!.sql, /c\.installation_id = \$2/);
  assert.equal(calls[1]!.values[1], 'installation-a');
});

test('point claims inherit the installation stored on their receipt session', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client: DbClient = {
    async query<T>(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes('AS installation_id') && sql.includes('WHERE r.id = $1')) {
        return { rows: [{ installation_id: 'installation-b' }] as T[], rowCount: 1 };
      }
      if (sql.startsWith('WITH used AS')) {
        return { rows: [{ points: 10 }] as T[], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const claim = await claimUserRewardPoints(client, 'user-1', 'receipt-1', 10, settings);

  assert.deepEqual(claim, { points: 10, reason: '' });
  assert.equal(calls[1]!.values[1], 'installation-b');
  assert.match(calls[2]!.sql, /c\.installation_id = \$3/);
  assert.match(calls[2]!.sql, /installation_id, campaign_key, points/);
  assert.equal(calls[2]!.values[2], 'installation-b');
});
