import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOcr, readReceipt, verifyOcr } from '../src/integrations/ocr';
import { providerResponseText } from '../src/integrations/ocr-provider';
import type { Env } from '../src/types';

const validExtraction = {
  isReceipt: true,
  confidence: 0.91,
  storeName: 'Hiperdino',
  headerText: 'DINOSOL SUPERMERCADOS, S.L.',
  ticketNumber: '2026/934211-00100048',
  ticketNumberText: 'Documento 2026/934211-00100048',
  purchaseDate: '2026-08-06',
  purchaseDateTime: '2026-08-06T09:01',
  purchaseDateText: 'Fecha 06/08/2026 Hora 09:01',
  totalCents: 1592,
  totalText: 'TOTAL COMPRA 15,92',
  currency: 'EUROS',
  rawText: 'DINOSOL\nDocumento 2026/934211-00100048\nFecha 06/08/2026\nTOTAL COMPRA 15,92',
};

test('OCR normalization keeps literal evidence and normalizes euros', () => {
  const receipt = normalizeOcr(validExtraction);
  assert.equal(receipt.currency, 'EUR');
  assert.equal(receipt.totalCents, 1592);
  assert.equal(receipt.evidence?.purchaseDateText, 'Fecha 06/08/2026 Hora 09:01');
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR verification accepts printed dates with a two-digit year', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    purchaseDateText: 'Fecha 06/08/26',
  });
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR verification rejects unsupported critical fields', () => {
  const receipt = normalizeOcr({
    isReceipt: true,
    confidence: 0.99,
    storeName: 'Hiperdino',
    ticketNumber: '000000000',
    purchaseDate: '2022-06-01',
    currency: 'EUR',
    rawText: 'TOTAL COMPRA: 15.99 EUROS',
  });
  assert.deepEqual(verifyOcr(receipt), [
    'UNVERIFIED_TICKET_NUMBER',
    'UNVERIFIED_DATE',
    'MISSING_TOTAL',
  ]);
});

test('OCR provider reads nested and streamed Workers AI responses', async () => {
  const nested = await providerResponseText({ response: { answer: '{"ok":true}' } });
  assert.equal(nested, '{"ok":true}');

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"answer":"{\\"ok\\":"}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"answer":"true}"}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
  assert.equal(await providerResponseText(stream), '{"ok":true}');
});

test('OCR retries an incomplete reading with focused regions', async () => {
  const requests: Record<string, unknown>[] = [];
  const answers = [
    {
      isReceipt: true,
      confidence: 0.99,
      storeName: 'Hiperdino',
      ticketNumber: '000000000',
      purchaseDate: '2022-06-01',
      currency: 'EUR',
      rawText: 'TOTAL COMPRA 15,99',
    },
    { ...validExtraction, totalCents: '', totalText: '' },
    { ...validExtraction, ticketNumber: '', ticketNumberText: '', purchaseDate: '', purchaseDateText: '' },
  ];
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/moondream/moondream3.1-9B-A2B',
    OCR_TIMEOUT_MS: '5000',
    AI: {
      async run(_model: string, input: Record<string, unknown>) {
        requests.push(input);
        return { answer: JSON.stringify(answers[requests.length - 1]) };
      },
    },
    IMAGES: {
      info: async () => ({ width: 1200, height: 1600, format: 'image/webp' }),
      input: () => {
        const transformer = {
          transform: () => transformer,
          output: () => ({ response: () => new Response(new Uint8Array([4, 5, 6])) }),
        };
        return transformer;
      },
    },
  } as unknown as Env;

  const result = await readReceipt(
    env,
    new Uint8Array([1, 2, 3]).buffer,
    'image/webp',
    [{ name: 'Hiperdino', aliases: ['Dinosol'] }],
  );

  assert.equal(result.attemptCount, 3);
  assert.equal(result.provider, 'workers-ai');
  assert.equal(result.receipt.purchaseDate, '2026-08-06');
  assert.equal(result.receipt.totalCents, 1592);
  assert.deepEqual(result.verificationIssues, []);
  assert.equal(requests[0]!.task, 'query');
  assert.match(String(requests[0]!.image), /^data:image\/webp;base64,/);
  assert.match(String(requests[1]!.question), /CABECERA/i);
  assert.match(String(requests[2]!.question), /parte INFERIOR/i);
});
