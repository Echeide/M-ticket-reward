import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldBanUser, userOffenseScore, USER_BAN_SCORE_THRESHOLD } from '../src/domain/user-ban';

test('six non-ticket images trigger a user ban', () => {
  assert.equal(USER_BAN_SCORE_THRESHOLD, 6);
  assert.equal(userOffenseScore('NOT_A_RECEIPT'), 1);
  assert.equal(shouldBanUser(5), false);
  assert.equal(shouldBanUser(6), true);
});

test('three confirmed frauds carry the same ban score', () => {
  assert.equal(userOffenseScore('CONFIRMED_FRAUD') * 3, USER_BAN_SCORE_THRESHOLD);
});

test('the configurable threshold preserves points and zero disables automatic bans', () => {
  assert.equal(shouldBanUser(4, 4), true);
  assert.equal(shouldBanUser(100, 0), false);
});
