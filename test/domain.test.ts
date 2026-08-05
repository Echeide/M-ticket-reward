import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTicketFingerprint } from '../src/domain/deduplication';
import { validateReceiptAutomatically } from '../src/domain/receipt';
import {
  resolveRewardPoints,
  reversalIdempotencyKey,
  rewardIdempotencyKey,
} from '../src/domain/rewards';
import { normalizeStoreInput } from '../src/domain/store';

const fields = {
  storeId: 'store-1',
  storeName: 'Tienda Uno',
  ticketNumber: 'A-123',
  purchaseDate: '2026-08-01',
  totalCents: 7_500,
  currency: 'EUR',
};

test('automatic validation approves a valid non-duplicate receipt', () => {
  const result = validateReceiptAutomatically({
    fields,
    ocr: { ...fields, isReceipt: true, confidence: 0.92 },
    storeActive: true,
    duplicate: false,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  assert.equal(result.approved, true);
  assert.deepEqual(result.reasons, []);
});

test('duplicates and non-receipt images never receive automatic approval', () => {
  const result = validateReceiptAutomatically({
    fields,
    ocr: { isReceipt: false, confidence: 0.2 },
    storeActive: true,
    duplicate: true,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  assert.equal(result.approved, false);
  assert.deepEqual(result.reasons, ['NOT_A_RECEIPT', 'DUPLICATE']);
});

test('reward tiers select the highest eligible purchase threshold', () => {
  const points = resolveRewardPoints(7_500, [
    { id: '1', minimumCents: 0, points: 5, active: true },
    { id: '2', minimumCents: 5_000, points: 20, active: true },
    { id: '3', minimumCents: 10_000, points: 50, active: true },
  ]);
  assert.equal(points, 20);
});

test('fingerprints and Rtales operations are deterministic', () => {
  assert.equal(buildTicketFingerprint(fields), 'STORE-1|A-123|2026-08-01|7500|EUR');
  assert.equal(rewardIdempotencyKey('receipt-1'), 'ticket:receipt-1:grant:v1');
  assert.equal(reversalIdempotencyKey('receipt-1'), 'ticket:receipt-1:revoke:v1');
});

test('store input normalizes codes and unique OCR aliases', () => {
  assert.deepEqual(normalizeStoreInput({
    code: ' tienda-uno ',
    name: 'Tienda Uno',
    aliases: ['Tienda Uno SL', 'Tienda Uno SL', ' T. Uno '],
    active: true,
  }), {
    code: 'TIENDA-UNO',
    name: 'Tienda Uno',
    aliases: ['Tienda Uno SL', 'T. Uno'],
    active: true,
  });
});

test('store input rejects unsafe or incomplete identifiers', () => {
  assert.throws(() => normalizeStoreInput({ code: '!', name: 'Tienda', aliases: [] }), /STORE_CODE_INVALID/);
  assert.throws(() => normalizeStoreInput({ code: 'OK', name: 'X', aliases: [] }), /STORE_NAME_INVALID/);
});
