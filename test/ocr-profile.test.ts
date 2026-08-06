import assert from 'node:assert/strict';
import test from 'node:test';
import { generateStoreOcrProfile, normalizeStoreOcrProfile } from '../src/domain/ocr-profile';

test('OCR profiles normalize editable guidance safely', () => {
  const profile = normalizeStoreOcrProfile({
    enabled: true,
    headerSignatures: ['  Comercio Uno  ', 'Comercio Uno'],
    ticketNumberRegion: 'somewhere',
    totalRegion: 'footer',
    instructions: '  Buscar el número junto a CAJA  ',
  });
  assert.equal(profile.enabled, true);
  assert.deepEqual(profile.headerSignatures, ['Comercio Uno']);
  assert.equal(profile.ticketNumberRegion, 'header');
  assert.equal(profile.totalRegion, 'footer');
  assert.equal(profile.instructions, 'Buscar el número junto a CAJA');
  assert.ok(profile.ignoredTotalLabels.includes('Subtotal'));
});

test('training evaluations generate merchant-specific OCR landmarks', () => {
  const profile = generateStoreOcrProfile(
    { name: 'Comercio Uno', aliases: ['Comercio Uno SL'] },
    [{
      notes: 'El total válido es el último TOTAL A PAGAR.',
      matches: { store: true, ticketNumber: true, purchaseDate: true, total: true },
      receipt: {
        isReceipt: true,
        confidence: 0.98,
        storeName: 'Comercio Uno',
        headerText: 'COMERCIO UNO\nB12345678',
        ticketNumber: 'A-12345',
        purchaseDate: '2026-08-06',
        totalCents: 1599,
        currency: 'EUR',
        rawText: '',
        evidence: {
          ticketNumberText: 'Documento: A-12345',
          purchaseDateText: 'Fecha operación: 06/08/2026 Hora: 9:01',
          totalText: 'TOTAL A PAGAR 15,99',
        },
      },
    }],
  );
  assert.equal(profile.enabled, false);
  assert.equal(profile.sampleCount, 1);
  assert.ok(profile.headerSignatures.includes('B12345678'));
  assert.deepEqual(profile.ticketNumberLabels, ['Documento']);
  assert.deepEqual(profile.dateLabels, ['Fecha operación', 'Hora']);
  assert.deepEqual(profile.totalLabels, ['TOTAL A PAGAR']);
  assert.equal(profile.dateFormat, 'DD/MM/AAAA');
  assert.match(profile.instructions, /último TOTAL A PAGAR/);
});

test('OCR profiles learn the majority Spanish date order across separators', () => {
  const result = (purchaseDateText: string) => ({
    matches: { store: true, purchaseDate: true },
    receipt: {
      isReceipt: true, confidence: 0.95, storeName: 'Comercio Uno', purchaseDate: '2026-08-06',
      evidence: { purchaseDateText },
    },
  });
  const profile = generateStoreOcrProfile(
    { name: 'Comercio Uno' },
    [result('Fecha 06-08-2026'), result('Fecha 06/08/2026'), result('Fecha 2026-08-06')],
  );
  assert.equal(profile.dateFormat, 'DD/MM/AAAA');
});

test('OCR profiles ignore landmarks from samples matched to another merchant', () => {
  const profile = generateStoreOcrProfile(
    { name: 'Comercio Uno', aliases: ['Comercio Uno SL'] },
    [{
      notes: 'Usar el CIF de esta cabecera.',
      matches: { store: false, ticketNumber: true, purchaseDate: true, total: true },
      receipt: {
        isReceipt: true,
        confidence: 0.98,
        storeName: 'Comercio Dos',
        headerText: 'COMERCIO DOS\nB87654321',
        ticketNumber: 'B-99999',
        purchaseDate: '2026-08-06',
        totalCents: 2599,
        currency: 'EUR',
        evidence: {
          ticketNumberText: 'Factura: B-99999',
          purchaseDateText: 'Fecha: 06/08/2026',
          totalText: 'TOTAL 25,99',
        },
      },
    }],
  );

  assert.equal(profile.sampleCount, 0);
  assert.equal(profile.headerSignatures.includes('B87654321'), false);
  assert.deepEqual(profile.ticketNumberLabels, []);
  assert.doesNotMatch(profile.instructions, /CIF/);
});
