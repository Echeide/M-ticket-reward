import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canResumeRewardInNewSession,
  databaseTimestampAfter,
  isRetryableRewardFailure,
  rewardFailureMinimumDelaySeconds,
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

test('Rtales session preparation responses remain pending and retry after a safe delay', () => {
  const failure = 'Game session is not ready to receive results';
  assert.equal(isRetryableRewardFailure(409, failure), true);
  assert.equal(isRetryableRewardFailure(400, failure.toUpperCase()), true);
  assert.equal(rewardFailureMinimumDelaySeconds(failure), 30);
});

test('reward failure classification keeps permanent client errors terminal', () => {
  assert.equal(isRetryableRewardFailure(400, 'Invalid points payload'), false);
  assert.equal(isRetryableRewardFailure(429, 'Rate limited'), true);
  assert.equal(isRetryableRewardFailure(503, 'Unavailable'), true);
  assert.equal(rewardFailureMinimumDelaySeconds('Unavailable'), 0);
});

test('pending session-related rewards can continue in a newly opened player session', () => {
  assert.equal(canResumeRewardInNewSession('REWARD_PENDING', 'PENDING', 'Game session is not ready to receive results'), true);
  assert.equal(canResumeRewardInNewSession('REWARD_PENDING', 'PROCESSING', null), true);
  assert.equal(canResumeRewardInNewSession('REWARD_FAILED', 'FAILED', 'RTALES_DELIVERY_TIMEOUT'), true);
  assert.equal(canResumeRewardInNewSession('REWARD_FAILED', 'FAILED', 'Game session is not ready to receive results'), true);
  assert.equal(canResumeRewardInNewSession('REWARD_FAILED', 'FAILED', 'RTALES_MAX_ATTEMPTS'), true);
  assert.equal(canResumeRewardInNewSession('REWARD_FAILED', 'FAILED', 'Invalid points payload'), false);
  assert.equal(canResumeRewardInNewSession('REWARDED', 'DELIVERED', null), false);
});
