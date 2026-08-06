import assert from 'node:assert/strict';
import test from 'node:test';
import {
  databaseTimestampAfter,
  rewardMaxAttempts,
  rewardRetryDelaySeconds,
} from '../src/domain/reward-delivery';

test('reward delivery uses bounded configuration defaults', () => {
  assert.equal(rewardMaxAttempts({}), 8);
  assert.equal(rewardMaxAttempts({ RTALES_REWARD_MAX_ATTEMPTS: '0' }), 1);
  assert.equal(rewardMaxAttempts({ RTALES_REWARD_MAX_ATTEMPTS: '200' }), 20);
});

test('reward retry delay grows exponentially and respects Retry-After', () => {
  assert.equal(rewardRetryDelaySeconds(1), 10);
  assert.equal(rewardRetryDelaySeconds(4), 80);
  assert.equal(rewardRetryDelaySeconds(2, 120), 120);
  assert.equal(rewardRetryDelaySeconds(20), 3600);
});

test('database retry timestamps are stored in a D1-compatible UTC format', () => {
  assert.equal(databaseTimestampAfter(10, Date.UTC(2026, 7, 6, 12, 0, 0)), '2026-08-06 12:00:10');
});
