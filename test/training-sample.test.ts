import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTrainingOcrCatalog,
  compareTrainingResult,
  normalizeTrainingSampleInput,
  trainingEvaluationPassed,
} from '../src/domain/training-sample';
import { emptyStoreOcrProfile } from '../src/domain/ocr-profile';

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
    purchaseDateTime: '',
    totalCents: 4830,
    currency: 'EUR',
    notes: 'Formato de caja nuevo',
  });
});

test('training samples accept date and time when the ticket has no printed number', () => {
  assert.deepEqual(normalizeTrainingSampleInput({
    ticketNumber: '',
    purchaseDate: '2026-08-05',
    purchaseDateTime: '2026-08-05T18:42',
    totalCents: 4830,
    currency: 'EUR',
  }), {
    ticketNumber: '',
    purchaseDate: '2026-08-05',
    purchaseDateTime: '2026-08-05T18:42',
    totalCents: 4830,
    currency: 'EUR',
    notes: '',
  });
});

test('training evaluation compares the alternative date and time identity', () => {
  const expected = normalizeTrainingSampleInput({
    ticketNumber: '', purchaseDate: '2026-08-05', purchaseDateTime: '2026-08-05T18:42',
    totalCents: 4830, currency: 'EUR',
  });
  const matches = compareTrainingResult(expected, {
    isReceipt: true, confidence: 0.95, storeName: 'Librería Atlántico', ticketNumber: '',
    purchaseDate: '2026-08-05', purchaseDateTime: '2026-08-05T18:42',
    totalCents: 4830, currency: 'EUR',
  }, true, []);
  assert.equal(trainingEvaluationPassed(matches), true);
  assert.equal(matches.purchaseTime, true);
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
    store: true, ticketNumber: true, purchaseDate: true, purchaseTime: true, total: true, evidence: true,
  });
  assert.equal(trainingEvaluationPassed(matches), true);
  assert.equal(trainingEvaluationPassed({ ...matches, evidence: false }), false);
});

test('training OCR catalog mirrors active production stores and applies only the candidate profile', () => {
  const candidateProfile = {
    ...emptyStoreOcrProfile(), enabled: true, headerSignatures: ['CANDIDATE SIGNATURE'],
  };
  const result = buildTrainingOcrCatalog([
    { id: 'target', active: true, name: 'Target', aliases: [], ocrProfile: emptyStoreOcrProfile() },
    { id: 'active-peer', active: true, name: 'Peer', aliases: [] },
    { id: 'inactive-peer', active: false, name: 'Hidden', aliases: [] },
  ], 'target', candidateProfile);

  assert.deepEqual(result.stores.map((store) => store.id), ['target', 'active-peer']);
  assert.equal(result.stores[0]?.ocrProfile, candidateProfile);
  assert.deepEqual(result.context, {
    catalogStoreCount: 2,
    targetStoreActive: true,
    targetIncludedOutsideProduction: false,
    profileMode: 'CANDIDATE',
  });
});

test('training OCR catalog can measure an inactive target without treating it as production-active', () => {
  const result = buildTrainingOcrCatalog([
    { id: 'active', active: true, name: 'Active', aliases: [] },
    { id: 'target', active: false, name: 'Target', aliases: [] },
    { id: 'inactive-peer', active: false, name: 'Hidden', aliases: [] },
  ], 'target', null);

  assert.deepEqual(result.stores.map((store) => store.id), ['active', 'target']);
  assert.equal(result.context.catalogStoreCount, 1);
  assert.equal(result.context.targetIncludedOutsideProduction, true);
  assert.equal(result.context.profileMode, 'PRODUCTION');
});
