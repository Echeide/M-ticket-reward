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

test('OCR verification accepts a printed time as identity when the receipt has no number', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    ticketNumber: '',
    ticketNumberText: '',
    purchaseDateTime: '2026-08-06T09:01',
    purchaseDateText: 'Fecha 06/08/2026 Hora 09:01',
  });
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR verification rejects a receipt with neither printed number nor matching time', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    ticketNumber: '',
    ticketNumberText: '',
    purchaseDateTime: '2026-08-06T09:01',
    purchaseDateText: 'Fecha 06/08/2026 Hora 09:02',
  });
  assert.deepEqual(verifyOcr(receipt), ['MISSING_TICKET_NUMBER_OR_TIME']);
});

test('OCR reading prefers verified date and time over an unsupported number candidate', async () => {
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/google/gemma-4-26b-a4b-it',
    OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_TIMEOUT_MS: '5000',
    AI: {
      async run() {
        return { choices: [{ message: { content: JSON.stringify({
          ...validExtraction,
          ticketNumber: 'CAJA-03',
          ticketNumberText: '',
        }) } }] };
      },
    },
  } as unknown as Env;

  const result = await readReceipt(env, new Uint8Array([1, 2, 3]).buffer, 'image/webp');
  assert.equal(result.receipt.ticketNumber, '');
  assert.equal(result.receipt.purchaseDateTime, '2026-08-06T09:01');
  assert.deepEqual(result.verificationIssues, []);
  assert.equal(result.attemptCount, 1);
});

test('OCR normalization repairs malformed dates and identifiers from labelled evidence', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    ticketNumber: 'B61742565',
    ticketNumberText: 'Documento 701108 2026/934211-00100048',
    purchaseDate: '2026/06/2026',
    purchaseDateText: 'Fecha 06/08/2026',
  });
  assert.equal(receipt.ticketNumber, '2026/934211-00100048');
  assert.equal(receipt.purchaseDate, '2026-08-06');
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR normalization is independent of merchant and receipt label', () => {
  const receipt = normalizeOcr({
    isReceipt: true,
    confidence: 0.94,
    storeName: 'Librería Atlántico',
    headerText: 'LIBRERÍA ATLÁNTICO S.L.\nAv. del Puerto 12',
    ticketNumber: 'A-004582',
    ticketNumberText: 'Recibo: A-004582',
    purchaseDate: '2026-08-05',
    purchaseDateText: '05-08-2026 18:42',
    totalCents: 4830,
    totalText: 'IMPORTE TOTAL 48,30 €',
    currency: 'EUR',
    rawText: 'LIBRERÍA ATLÁNTICO\nRecibo: A-004582\n05-08-2026\nIMPORTE TOTAL 48,30 €',
  });

  assert.equal(receipt.storeName, 'Librería Atlántico');
  assert.equal(receipt.ticketNumber, 'A-004582');
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

  const contentParts = await providerResponseText({
    choices: [{ message: { content: [{ type: 'text', text: '{"ok":true}' }] } }],
  });
  assert.equal(contentParts, '{"ok":true}');
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
    [{
      name: 'Hiperdino', aliases: ['Dinosol'],
      ocrProfile: {
        version: 1, enabled: true, headerSignatures: ['DINOSOL SUPERMERCADOS'],
        ticketNumberLabels: ['Documento'], dateLabels: ['Fecha operación'],
        totalLabels: ['TOTAL COMPRA'], ignoredTotalLabels: ['Subtotal'],
        ticketNumberRegion: 'header', dateRegion: 'header', totalRegion: 'footer',
        dateFormat: 'DD/MM/AAAA', instructions: 'Ignorar el número de caja.', sampleCount: 3,
      },
    }],
  );

  assert.equal(result.attemptCount, 3);
  assert.equal(result.provider, 'workers-ai');
  assert.equal(result.receipt.purchaseDate, '2026-08-06');
  assert.equal(result.receipt.totalCents, 1592);
  assert.deepEqual(result.verificationIssues, []);
  assert.equal(requests[0]!.task, 'query');
  assert.match(String(requests[0]!.image), /^data:image\/webp;base64,/);
  assert.match(String(requests[1]!.question), /CABECERA/i);
  assert.match(String(requests[1]!.question), /Fecha operación/);
  assert.match(String(requests[2]!.question), /parte INFERIOR/i);
  assert.match(String(requests[2]!.question), /TOTAL COMPRA/);
});

test('Workers AI chat format supports Llama vision with JSON mode', async () => {
  let model = '';
  let input: Record<string, unknown> = {};
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_TIMEOUT_MS: '5000',
    AI: {
      async run(selectedModel: string, selectedInput: Record<string, unknown>) {
        model = selectedModel;
        input = selectedInput;
        return { choices: [{ message: { content: JSON.stringify(validExtraction) } }] };
      },
    },
  } as unknown as Env;

  const result = await readReceipt(env, new Uint8Array([1, 2, 3]).buffer, 'image/webp');

  assert.equal(model, '@cf/meta/llama-3.2-11b-vision-instruct');
  assert.equal(result.attemptCount, 1);
  assert.equal(Array.isArray(input.messages), true);
  assert.match(String(input.image), /^data:image\/webp;base64,/);
  assert.deepEqual(input.response_format, { type: 'json_object' });
  assert.equal(input.max_tokens, 2_048);
  assert.equal(input.max_completion_tokens, undefined);
  assert.equal(input.task, undefined);
});
