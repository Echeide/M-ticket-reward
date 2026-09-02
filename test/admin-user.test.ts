import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminRouteAllowed,
  canCreateAdminRole,
  canDeleteAdminRole,
  normalizeAdminEmail,
  normalizeAssignableAdminRole,
} from '../src/domain/admin-user';

test('administrator emails are normalized for stable authorization', () => {
  assert.equal(normalizeAdminEmail(' Admin@Example.COM '), 'admin@example.com');
});

test('invalid administrator emails are rejected', () => {
  assert.throws(() => normalizeAdminEmail('not-an-email'), /ADMIN_EMAIL_INVALID/);
  assert.throws(() => normalizeAdminEmail(''), /ADMIN_EMAIL_INVALID/);
});

test('only administrator and operator are assignable roles', () => {
  assert.equal(normalizeAssignableAdminRole('ADMIN'), 'ADMIN');
  assert.equal(normalizeAssignableAdminRole('OPERATOR'), 'OPERATOR');
  assert.throws(() => normalizeAssignableAdminRole('SUPERADMIN'), /ADMIN_ROLE_INVALID/);
});

test('administrators can manage operators but cannot create or delete administrators', () => {
  assert.equal(canCreateAdminRole('SUPERADMIN', 'ADMIN'), true);
  assert.equal(canCreateAdminRole('SUPERADMIN', 'OPERATOR'), true);
  assert.equal(canCreateAdminRole('ADMIN', 'OPERATOR'), true);
  assert.equal(canCreateAdminRole('ADMIN', 'ADMIN'), false);
  assert.equal(canCreateAdminRole('OPERATOR', 'OPERATOR'), false);
  assert.equal(canDeleteAdminRole('ADMIN', 'OPERATOR'), true);
  assert.equal(canDeleteAdminRole('ADMIN', 'ADMIN'), false);
  assert.equal(canDeleteAdminRole('SUPERADMIN', 'ADMIN'), true);
  assert.equal(canDeleteAdminRole('SUPERADMIN', 'SUPERADMIN'), false);
});

test('operator routes are limited to review and read-only store and settings access', () => {
  assert.equal(adminRouteAllowed('OPERATOR', 'GET', '/api/admin/receipts'), true);
  assert.equal(adminRouteAllowed('OPERATOR', 'GET', '/api/admin/spaces'), true);
  assert.equal(adminRouteAllowed('OPERATOR', 'GET', '/api/admin/receipts/ticket-id/image'), true);
  assert.equal(adminRouteAllowed('OPERATOR', 'POST', '/api/admin/receipts/ticket-id/review'), true);
  assert.equal(adminRouteAllowed('OPERATOR', 'POST', '/api/admin/receipts/ticket-id/reprocess'), true);
  assert.equal(adminRouteAllowed('OPERATOR', 'GET', '/api/admin/stores'), true);
  assert.equal(adminRouteAllowed('OPERATOR', 'GET', '/api/admin/stores/store-id/training'), true);
  assert.equal(adminRouteAllowed('OPERATOR', 'GET', '/api/admin/stores/store-id/product-campaigns'), true);
  assert.equal(adminRouteAllowed('OPERATOR', 'POST', '/api/admin/stores/store-id/product-campaigns'), false);
  assert.equal(adminRouteAllowed('OPERATOR', 'GET', '/api/admin/settings'), true);
  assert.equal(adminRouteAllowed('OPERATOR', 'POST', '/api/admin/stores'), false);
  assert.equal(adminRouteAllowed('OPERATOR', 'GET', '/api/admin/stores/store-id/deletion-preview'), false);
  assert.equal(adminRouteAllowed('OPERATOR', 'DELETE', '/api/admin/stores/store-id'), false);
  assert.equal(adminRouteAllowed('OPERATOR', 'POST', '/api/admin/stores/store-id/restore'), false);
  assert.equal(adminRouteAllowed('OPERATOR', 'PATCH', '/api/admin/settings/home.title'), false);
  assert.equal(adminRouteAllowed('OPERATOR', 'PATCH', '/api/admin/settings/scan-flow'), false);
  assert.equal(adminRouteAllowed('OPERATOR', 'GET', '/api/admin/users'), false);
  assert.equal(adminRouteAllowed('OPERATOR', 'DELETE', '/api/admin/receipts/ticket-id'), false);
  assert.equal(adminRouteAllowed('ADMIN', 'PATCH', '/api/admin/settings/home.title'), true);
});
