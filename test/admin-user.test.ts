import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAdminEmail } from '../src/domain/admin-user';

test('administrator emails are normalized for stable authorization', () => {
  assert.equal(normalizeAdminEmail(' Admin@Example.COM '), 'admin@example.com');
});

test('invalid administrator emails are rejected', () => {
  assert.throws(() => normalizeAdminEmail('not-an-email'), /ADMIN_EMAIL_INVALID/);
  assert.throws(() => normalizeAdminEmail(''), /ADMIN_EMAIL_INVALID/);
});
