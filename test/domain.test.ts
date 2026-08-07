import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTicketFingerprint } from '../src/domain/deduplication';
import {
  canReprocessReceipt,
  compareReceiptDeclaration,
  receiptStatusAfterOcr,
  normalizeReceiptDeclaration,
  validateReceiptAutomatically,
  isValidIsoDate,
} from '../src/domain/receipt';
import {
  resolveRewardPoints,
  reversalIdempotencyKey,
  rewardIdempotencyKey,
} from '../src/domain/rewards';
import { findMatchingStore, normalizeStoreInput, storeHasVisibleEvidence } from '../src/domain/store';
import { normalizeRewardTierInput } from '../src/domain/reward-tier';
import {
  APP_SETTING_DEFINITIONS,
  appSettingsWithDefaults,
  booleanAppSetting,
  normalizeAppSettingValue,
  validateAppSettingPeriod,
} from '../src/domain/app-settings';

const fields = {
  storeId: 'store-1',
  storeName: 'Tienda Uno',
  ticketNumber: 'A-123',
  purchaseDate: '2026-08-02',
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

test('receipt declarations are normalized and compared independently from OCR evidence', () => {
  const declaration = normalizeReceiptDeclaration({
    storeId: 'store-1', ticketNumber: ' A / 123 ', totalCents: '7500',
  }, true);
  assert.deepEqual(declaration, {
    storeId: 'store-1', ticketNumber: 'A / 123', totalCents: 7500, currency: 'EUR',
  });
  assert.deepEqual(compareReceiptDeclaration(declaration, fields), []);
  assert.deepEqual(compareReceiptDeclaration(declaration, {
    ...fields, storeId: 'store-2', ticketNumber: 'A-124', totalCents: 7600,
  }), [
    'DECLARED_STORE_MISMATCH',
    'DECLARED_TICKET_NUMBER_MISMATCH',
    'DECLARED_TOTAL_MISMATCH',
  ]);
});

test('assisted scan declarations require safe document, amount and optionally a store', () => {
  assert.deepEqual(normalizeReceiptDeclaration({
    ticketNumber: 'DOC-123', totalCents: 1592,
  }, false).storeId, '');
  assert.throws(() => normalizeReceiptDeclaration({ ticketNumber: 'DOC-123', totalCents: 1592 }, true), /DECLARED_STORE_REQUIRED/);
  assert.throws(() => normalizeReceiptDeclaration({ storeId: 'store-1', ticketNumber: 'x', totalCents: 1592 }, true), /DECLARED_TICKET_NUMBER_INVALID/);
  assert.throws(() => normalizeReceiptDeclaration({ storeId: 'store-1', ticketNumber: 'DOC-123', totalCents: 0 }, true), /DECLARED_TOTAL_INVALID/);
});

test('automatic validation accepts a verified purchase time when no ticket number is printed', () => {
  const fieldsWithoutNumber = {
    ...fields,
    ticketNumber: '',
    purchaseDateTime: '2026-08-02T09:17',
  };
  const result = validateReceiptAutomatically({
    fields: fieldsWithoutNumber,
    ocr: {
      ...fieldsWithoutNumber,
      isReceipt: true,
      confidence: 0.92,
      evidence: { purchaseDateText: 'Fecha 02/08/2026 Hora 09:17' },
    },
    storeActive: true,
    duplicate: false,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  assert.equal(result.approved, true);
  assert.deepEqual(result.reasons, []);
});

test('automatic validation still rejects receipts without a number or verified purchase time', () => {
  const result = validateReceiptAutomatically({
    fields: { ...fields, ticketNumber: '' },
    ocr: { ...fields, ticketNumber: '', isReceipt: true, confidence: 0.92 },
    storeActive: true,
    duplicate: false,
    now: new Date('2026-08-05T12:00:00Z'),
  });
  assert.deepEqual(result.reasons, ['TICKET_NUMBER_OR_TIME_REQUIRED']);
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

test('automatic validation only accepts receipt dates within three calendar days', () => {
  const validateDate = (purchaseDate: string) => validateReceiptAutomatically({
    fields: { ...fields, purchaseDate },
    ocr: { ...fields, purchaseDate, isReceipt: true, confidence: 0.92 },
    storeActive: true,
    duplicate: false,
    now: new Date('2026-08-05T12:00:00Z'),
  });

  assert.equal(validateDate('2026-08-02').approved, true);
  assert.equal(validateDate('2026-08-08').approved, true);
  assert.deepEqual(validateDate('2026-08-01').reasons, ['TICKET_TOO_OLD']);
  assert.deepEqual(validateDate('2026-08-09').reasons, ['FUTURE_DATE']);
  assert.deepEqual(validateDate('2026-02-30').reasons, ['INVALID_DATE']);
});

test('manual correction date validation rejects impossible calendar dates', () => {
  assert.equal(isValidIsoDate('2026-08-06'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('06/08/2026'), false);
});

test('configured campaign dates replace the default three-day ticket window', () => {
  const validatePeriod = (purchaseDate: string, purchaseDateTime?: string) => validateReceiptAutomatically({
    fields: { ...fields, purchaseDate },
    ocr: { ...fields, purchaseDate, purchaseDateTime, isReceipt: true, confidence: 0.92 },
    storeActive: true,
    duplicate: false,
    now: new Date('2026-08-05T12:00:00Z'),
    allowedPurchaseStart: '2026-07-01T09:00',
    allowedPurchaseEnd: '2026-09-30T22:00',
  });

  assert.equal(validatePeriod('2026-07-10').approved, true);
  assert.deepEqual(validatePeriod('2026-06-30').reasons, ['TICKET_TOO_OLD']);
  assert.deepEqual(validatePeriod('2026-10-01').reasons, ['FUTURE_DATE']);
  assert.equal(validatePeriod('2026-09-30', '2026-09-30T21:59').approved, true);
  assert.deepEqual(validatePeriod('2026-09-30', '2026-09-30T22:01').reasons, ['FUTURE_DATE']);
});

test('only fully valid OCR results continue to automatic reward delivery', () => {
  assert.equal(receiptStatusAfterOcr({ approved: true, riskScore: 0, reasons: [] }), 'REWARD_PENDING');
  assert.equal(receiptStatusAfterOcr({
    approved: false, riskScore: 0, reasons: ['STORE_NOT_ALLOWED'],
  }), 'AUTO_REJECTED');
  assert.equal(receiptStatusAfterOcr({
    approved: false, riskScore: 0, reasons: ['NOT_A_RECEIPT', 'INVALID_TOTAL'],
  }), 'NOT_A_RECEIPT');
  assert.equal(receiptStatusAfterOcr({
    approved: false, riskScore: 0, reasons: ['DUPLICATE'],
  }), 'DUPLICATE');
});

test('OCR reprocessing is limited to receipts that cannot duplicate rewards', () => {
  assert.equal(canReprocessReceipt('AUTO_REJECTED'), true);
  assert.equal(canReprocessReceipt('NOT_A_RECEIPT'), true);
  assert.equal(canReprocessReceipt('READY_FOR_CONFIRMATION'), true);
  assert.equal(canReprocessReceipt('REWARD_FAILED', ['OCR_PROCESSING_FAILED']), true);
  assert.equal(canReprocessReceipt('REWARD_FAILED', ['OCR_VERIFICATION_REQUIRED']), true);
  assert.equal(canReprocessReceipt('REWARD_FAILED', ['RTALES_DELIVERY_FAILED']), false);
  assert.equal(canReprocessReceipt('REWARDED'), false);
  assert.equal(canReprocessReceipt('REWARD_PENDING'), false);
  assert.equal(canReprocessReceipt('DUPLICATE'), false);
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
  assert.equal(buildTicketFingerprint(fields), 'STORE-1|A-123|2026-08-02|7500|EUR');
  assert.equal(buildTicketFingerprint({
    ...fields, ticketNumber: '', purchaseDateTime: '2026-08-02T09:17',
  }), 'STORE-1|@TIME:2026-08-02T09:17|2026-08-02|7500|EUR');
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

test('store matching recovers an authorized merchant from the fiscal header', () => {
  const stores = [
    { id: 'store-1', name: 'Supermercados Atlántico', aliases: ['Atlantico S.L.'] },
    { id: 'store-2', name: 'Comercial Teide', aliases: ['Teide Market'] },
  ];
  const selected = findMatchingStore(stores, {
    storeName: 'Yogur natural pack 4',
    headerText: 'ATLANTICO S.L.\nCIF B12345678\nAv. Principal 10',
    rawText: 'ATLANTICO S.L.\nCIF B12345678\nYogur natural pack 4',
  });
  assert.equal(selected?.id, 'store-1');
});

test('a declared store still requires independent visible header evidence', () => {
  const store = { name: 'Hiperdino', aliases: ['DINOSOL SUPERMERCADOS, S.L.'] };
  assert.equal(storeHasVisibleEvidence(store, {
    headerText: 'DINOSOL SUPERMERCADOS, S.L.\nCIF B61742565',
  }), true);
  assert.equal(storeHasVisibleEvidence(store, {
    headerText: 'SUPERMERCADO DESCONOCIDO',
  }), false);
});

test('store matching does not search merchant names deep in the item list', () => {
  const stores = [{ id: 'store-1', name: 'Comercial Teide', aliases: ['Teide Market'] }];
  const selected = findMatchingStore(stores, {
    storeName: 'Producto promocional',
    rawText: `${'CABECERA DESCONOCIDA '.repeat(70)} Teide Market camiseta`,
  });
  assert.equal(selected, null);
});

test('store matching uses active learned header signatures', () => {
  const profile = {
    version: 1 as const, enabled: true, headerSignatures: ['B12345678'],
    ticketNumberLabels: [], dateLabels: [], totalLabels: [], ignoredTotalLabels: [],
    ticketNumberRegion: 'header' as const, dateRegion: 'header' as const,
    totalRegion: 'footer' as const, dateFormat: '', instructions: '', sampleCount: 3,
  };
  const stores = [{ id: 'store-1', name: 'Comercio Uno', aliases: [], ocrProfile: profile }];
  assert.equal(findMatchingStore(stores, {
    storeName: 'Nombre parcialmente ilegible',
    headerText: 'TIENDA LOCAL\nCIF B12345678\nLas Palmas',
  })?.id, 'store-1');
  profile.enabled = false;
  assert.equal(findMatchingStore(stores, { headerText: 'CIF B12345678' }), null);
});

test('reward tiers use the highest reached threshold without accumulating', () => {
  const tiers = [
    { id: '50', minimumCents: 5_000, points: 10, active: true },
    { id: '100', minimumCents: 10_000, points: 20, active: true },
  ];
  assert.equal(resolveRewardPoints(4_999, tiers), 0);
  assert.equal(resolveRewardPoints(5_000, tiers), 10);
  assert.equal(resolveRewardPoints(12_500, tiers), 20);
});

test('reward tier management accepts integer cents and points only', () => {
  assert.deepEqual(normalizeRewardTierInput({ minimumCents: 5_000, points: 10, active: true }), {
    minimumCents: 5_000, points: 10, active: true,
  });
  assert.throws(() => normalizeRewardTierInput({ minimumCents: 50.5, points: 10 }), /TIER_MINIMUM_INVALID/);
  assert.throws(() => normalizeRewardTierInput({ minimumCents: 5_000, points: -1 }), /TIER_POINTS_INVALID/);
});

test('application settings retain defaults and override only stored values', () => {
  const settings = appSettingsWithDefaults([
    { key: 'home.title', value: 'Una portada personalizada' },
    { key: 'unknown.setting', value: 'Ignorado' },
  ]);
  assert.equal(settings['home.title'], 'Una portada personalizada');
  assert.equal(settings['home.scanButton'], 'Escanear ticket');
  assert.equal(settings['scan.assisted.enabled'], 'true');
  assert.equal(settings['scan.assisted.requireStore'], 'true');
  assert.equal(booleanAppSetting(settings, 'scan.assisted.enabled'), true);
  assert.equal(Object.keys(settings).length, APP_SETTING_DEFINITIONS.length);
  assert.equal(settings['unknown.setting'], undefined);
});

test('application settings validate keys, normalize line endings and enforce limits', () => {
  assert.equal(normalizeAppSettingValue('home.title', '  Nuevo título  '), 'Nuevo título');
  assert.equal(normalizeAppSettingValue('home.description', 'Línea 1\r\n**Línea 2**'), 'Línea 1\n**Línea 2**');
  assert.throws(() => normalizeAppSettingValue('unknown.setting', 'valor'), /APP_SETTING_UNKNOWN/);
  assert.throws(() => normalizeAppSettingValue('home.title', 12), /APP_SETTING_VALUE_INVALID/);
  assert.throws(() => normalizeAppSettingValue('home.scanButton', 'x'.repeat(101)), /APP_SETTING_TOO_LONG/);
  assert.equal(normalizeAppSettingValue('validation.startAt', '2026-08-01T09:30'), '2026-08-01T09:30');
  assert.equal(normalizeAppSettingValue('validation.endAt', ''), '');
  assert.equal(normalizeAppSettingValue('limits.dailyTicketsPerUserStore', '03'), '3');
  assert.equal(normalizeAppSettingValue('limits.totalUploadsPerUser', '0'), '0');
  assert.equal(normalizeAppSettingValue('scan.assisted.enabled', 'false'), 'false');
  assert.throws(() => normalizeAppSettingValue('scan.assisted.enabled', '1'), /APP_SETTING_BOOLEAN_INVALID/);
  assert.throws(() => normalizeAppSettingValue('limits.banScoreThreshold', '-1'), /APP_SETTING_INTEGER_INVALID/);
  assert.throws(() => normalizeAppSettingValue('limits.dailyTicketsPerUserStore', '101'), /APP_SETTING_INTEGER_INVALID/);
  assert.throws(() => normalizeAppSettingValue('validation.startAt', '2026-02-30T09:30'), /APP_SETTING_DATETIME_INVALID/);
  assert.throws(() => validateAppSettingPeriod({
    'validation.startAt': '2026-09-01T09:00',
    'validation.endAt': '2026-08-01T09:00',
  }), /APP_SETTING_PERIOD_INVALID/);
});
