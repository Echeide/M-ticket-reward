import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareTrainingResult,
  normalizeTrainingSampleInput,
  trainingEvaluationPassed,
} from '../src/domain/training-sample';

test('training samples normalize verified ground truth', () => {
  assert.deepEqual(normalizeTrainingSampleInput({
    ticketNumber: ' A-004582 ',
    purchaseDate: '2026-08-05',
    totalCents: 4830,
    currency: 'eur',
    notes: ' Formato de caja nuevo ',
  }), {
    ticketNumber: 'A-004582',
    purchaseDate: '2026-08-05',
    totalCents: 4830,
    currency: 'EUR',
    notes: 'Formato de caja nuevo',
  });
});

test('training samples reject incomplete or impossible ground truth', () => {
  assert.throws(() => normalizeTrainingSampleInput({
    ticketNumber: '1', purchaseDate: '2026-02-30', totalCents: 0,
  }));
});

test('evaluation compares every critical field and visible evidence', () => {
  const expected = normalizeTrainingSampleInput({
    ticketNumber: 'A-004582', purchaseDate: '2026-08-05', totalCents: 4830, currency: 'EUR',
  });
  const matches = compareTrainingResult(expected, {
    isReceipt: true,
    confidence: 0.95,
    storeName: 'Librería Atlántico',
    ticketNumber: 'A 004582',
    purchaseDate: '2026-08-05',
    totalCents: 4830,
    currency: 'EUR',
    rawText: '',
  }, true, []);
  assert.deepEqual(matches, {
    store: true, ticketNumber: true, purchaseDate: true, total: true, evidence: true,
  });
  assert.equal(trainingEvaluationPassed(matches), true);
  assert.equal(trainingEvaluationPassed({ ...matches, evidence: false }), false);
});
