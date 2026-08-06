import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePostgresQuery } from '../src/platform/db';

test('D1 query compiler expands PostgreSQL array predicates', () => {
  const compiled = compilePostgresQuery(
    'SELECT id FROM receipts WHERE user_ref = $1 AND status = ANY($2::text[])',
    ['player-1', ['OCR_QUEUED', 'REWARDED']],
  );
  assert.equal(
    compiled.statement,
    'SELECT id FROM receipts WHERE user_ref = ? AND status IN (?, ?)',
  );
  assert.deepEqual(compiled.bindings, ['player-1', 'OCR_QUEUED', 'REWARDED']);
});

test('D1 query compiler converts PostgreSQL dates, locks and JSON casts', () => {
  const compiled = compilePostgresQuery(
    `UPDATE receipts SET validation_reasons = $2::jsonb, updated_at = NOW()
       WHERE id = $1 FOR UPDATE`,
    ['receipt-1', '["VALID"]'],
  );
  assert.match(compiled.statement, /validation_reasons = \?/);
  assert.match(compiled.statement, /updated_at = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(compiled.statement, /jsonb|FOR UPDATE|\$\d/);
  assert.deepEqual(compiled.bindings, ['["VALID"]', 'receipt-1']);
});

test('D1 query compiler reuses exact lookup bindings for filtering and priority ordering', () => {
  const compiled = compilePostgresQuery(
    `SELECT id FROM external_users
      WHERE rtales_lookup_code_normalized = $1 OR display_name ILIKE $2
      ORDER BY CASE WHEN rtales_lookup_code_normalized = $1 THEN 0 ELSE 1 END`,
    ['MARIA4827', '%María%'],
  );
  assert.deepEqual(compiled.bindings, ['MARIA4827', '%María%', 'MARIA4827']);
});
