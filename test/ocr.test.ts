import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOcr, OcrReadError, readReceipt, verifyOcr } from '../src/integrations/ocr';
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
  rawText: 'DINOSOL\nDocumento 2026/934211-00100048\nFecha 06/08/2026 Hora 09:01\nTOTAL COMPRA 15,92',
};

test('OCR normalization keeps literal evidence and normalizes euros', () => {
  const receipt = normalizeOcr(validExtraction);
  assert.equal(receipt.currency, 'EUR');
  assert.equal(receipt.totalCents, 1592);
  assert.equal(receipt.evidence?.purchaseDateText, 'Fecha 06/08/2026 Hora 09:01');
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR normalization trusts a visible decimal total over a shifted model integer', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    totalCents: 1740,
    totalText: 'TOTAL COMPRA: 1,74',
    rawText: 'HIPERDINO\nFecha 06/08/2026 Hora 09:01\nARTICULO IMPORTE 1,74\nTOTAL COMPRA: 1,74',
  });
  assert.equal(receipt.totalCents, 174);
  assert.equal(receipt.evidence?.totalText, 'TOTAL COMPRA: 1,74');
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR normalization separates an invoice number from its date and accepts one decimal totals', () => {
  const receipt = normalizeOcr({
    isReceipt: true,
    confidence: 0.99,
    storeName: 'Echeide',
    headerText: 'ECHEIDE\nEcheide, Soluciones en Comunicación y Nuevas tecnologías SLU',
    ticketNumber: '12/08/26',
    ticketNumberText: 'Factura: 8008 - 12/08/26 - 10:27',
    purchaseDate: '2026-08-12',
    purchaseDateTime: '2026-08-12T10:27',
    purchaseDateText: 'Factura: 8008 - 12/08/26 - 10:27',
    totalCents: 606,
    totalText: 'Total 6,06€',
    currency: 'EUR',
    rawText: 'ECHEIDE\nFactura: 8008 - 12/08/26 - 10:27\nTotal\n6,0€',
  });

  assert.equal(receipt.ticketNumber, '8008');
  assert.equal(receipt.totalCents, 600);
  assert.equal(receipt.evidence?.totalText, 'Total\n6,0');
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR normalization rejects promotional text and dates absent from the raw evidence', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    ticketNumber: 'VITAMINAS/VITAMINAS/B1',
    ticketNumberText: 'Documento VITAMINAS/VITAMINAS/B1',
    purchaseDate: '2026-08-07',
    purchaseDateTime: '2026-08-07T08:39',
    purchaseDateText: '07/08/2026 08:39',
    totalCents: 174,
    totalText: 'TOTAL COMPRA: 1,74',
    rawText: 'HIPERDINO\nDOCUMENTO DE VENTA\nPLAN DINOBP\nVITAMINAS/VITAMINAS/B1 B2 B3 B9\nTOTAL COMPRA: 1,74',
  });
  assert.equal(receipt.ticketNumber, '');
  assert.equal(receipt.purchaseDateTime, undefined);
  assert.equal(receipt.evidence?.purchaseDateText, '');
  assert.deepEqual(verifyOcr(receipt), ['MISSING_TICKET_NUMBER_OR_TIME', 'UNVERIFIED_DATE']);
});

test('OCR verification accepts printed dates with a two-digit year', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    purchaseDateText: 'Fecha 06/08/26',
  });
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR normalization corrects an ISO date that conflicts with Spanish printed order', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    purchaseDate: '2026-06-08',
    purchaseDateTime: '',
    purchaseDateText: 'Fecha 06/08/2026',
  });
  assert.equal(receipt.purchaseDate, '2026-08-06');
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR verification accepts Spanish textual dates and single-digit hours', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    ticketNumber: '',
    ticketNumberText: '',
    purchaseDateText: 'Fecha 6 de agosto de 2026 Hora 9:01',
    rawText: 'HIPERDINO\nFecha 6 de agosto de 2026 Hora 9:01\nTOTAL COMPRA 15,92',
  });
  assert.equal(receipt.purchaseDate, '2026-08-06');
  assert.equal(receipt.purchaseDateTime, '2026-08-06T09:01');
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR verification accepts a printed time as identity when the receipt has no number', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    ticketNumber: '',
    ticketNumberText: '',
    purchaseDateTime: '2026-08-06T09:01',
    purchaseDateText: 'Fecha 06/08/2026 Hora 09:01',
    rawText: 'HIPERDINO\nFecha 06/08/2026 Hora 09:01\nTOTAL COMPRA 15,92',
  });
  assert.equal(receipt.ticketNumber, '');
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR normalization combines Llama time-only output with the verified purchase date', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    ticketNumber: '',
    ticketNumberText: '',
    purchaseDate: '06/08/2026',
    purchaseDateTime: '09:01',
    purchaseDateText: 'Fecha 06/08/2026 Hora 09:01',
  });
  assert.equal(receipt.purchaseDate, '2026-08-06');
  assert.equal(receipt.purchaseDateTime, '2026-08-06T09:01');
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR normalization recovers Llama identity fields from literal raw evidence', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    ticketNumber: '934211-001000048',
    ticketNumberText: 'Documento',
    purchaseDateTime: '',
    purchaseDateText: 'Fecha Hora 06/08/2026 09:01',
    rawText: 'DINOSOL SUPERMERCADOS Documento Fecha Hora 2026/934211-001000048 06/08/2026 09:01 ARTICULO IMPORTE',
  });
  assert.equal(receipt.ticketNumber, '2026/934211-001000048');
  assert.equal(receipt.purchaseDateTime, '2026-08-06T09:01');
  assert.equal(receipt.evidence?.ticketNumberText, 'Documento 2026/934211-001000048');
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR normalization verifies sparse Llama evidence against the literal raw text', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    ticketNumber: '2026/934211-001000048',
    ticketNumberText: 'Documento',
    purchaseDate: '06/08/2026',
    purchaseDateTime: '',
    purchaseDateText: 'Fecha Hora',
    totalCents: 1592,
    totalText: 'TOTAL COMPRA:',
    rawText: 'DINOSOL SUPERMERCADOS Documento 2026/934211-001000048 Fecha 06/08/2026 Hora 09:01 TOTAL COMPRA: 15,92',
  });
  assert.equal(receipt.purchaseDate, '2026-08-06');
  assert.equal(receipt.purchaseDateTime, '2026-08-06T09:01');
  assert.match(receipt.evidence?.purchaseDateText || '', /06\/08\/2026 Hora 09:01/);
  assert.equal(receipt.evidence?.totalText, 'TOTAL COMPRA: 15,92');
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR normalization prefers the literal printed time over a conflicting model value', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    ticketNumber: '',
    ticketNumberText: '',
    purchaseDateTime: '2026-08-06T09:01',
    purchaseDateText: 'Fecha 06/08/2026 Hora 09:02',
    rawText: 'HIPERDINO\nFecha 06/08/2026 Hora 09:02\nTOTAL COMPRA 15,92',
  });
  assert.equal(receipt.purchaseDateTime, '2026-08-06T09:02');
  assert.deepEqual(verifyOcr(receipt), []);
});

test('OCR normalization discards a time without literal evidence', () => {
  const receipt = normalizeOcr({
    ...validExtraction,
    ticketNumber: '',
    ticketNumberText: '',
    purchaseDateTime: '2026-08-06T09:01',
    purchaseDateText: 'Fecha 06/08/2026',
    rawText: 'HIPERDINO\nFecha 06/08/2026\nTOTAL COMPRA 15,92',
  });
  assert.equal(receipt.purchaseDateTime, undefined);
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
          rawText: 'HIPERDINO\nFecha 06/08/2026 Hora 09:01\nTOTAL COMPRA 15,92',
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

test('OCR reading repairs literal control characters inside JSON strings', async () => {
  const malformedJson = JSON.stringify(validExtraction)
    .replace('DINOSOL\\nDocumento', 'DINOSOL\nDocumento')
    .replace('Fecha 06/08/2026\\nTOTAL', 'Fecha 06/08/2026\tTOTAL');
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_TIMEOUT_MS: '5000',
    AI: {
      async run() {
        return { choices: [{ message: { content: malformedJson } }] };
      },
    },
  } as unknown as Env;

  const result = await readReceipt(env, new Uint8Array([1, 2, 3]).buffer, 'image/webp');

  assert.match(result.receipt.rawText || '', /DINOSOL\nDocumento/);
  assert.deepEqual(result.verificationIssues, []);
});

test('OCR reading accepts conservative JSON-like repairs without another model call', async () => {
  let calls = 0;
  const relaxed = `{{${JSON.stringify(validExtraction).slice(1, -1)
    .replace('"isReceipt":true', 'isReceipt: True')
    .replace('"storeName":"Hiperdino"', "storeName: 'Hiperdino'")},}}`;
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_TIMEOUT_MS: '5000',
    AI: {
      async run() {
        calls += 1;
        return { choices: [{ message: { content: `Here's the result:\n${relaxed}` } }] };
      },
    },
  } as unknown as Env;

  const result = await readReceipt(env, new Uint8Array([1, 2, 3]).buffer, 'image/webp');

  assert.equal(calls, 1);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.receipt.storeName, 'Hiperdino');
  assert.deepEqual(result.verificationIssues, []);
});

test('OCR reading retries a malformed model response once', async () => {
  let calls = 0;
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_TIMEOUT_MS: '5000',
    AI: {
      async run() {
        calls += 1;
        const content = calls === 1 ? '{ definitely not json }' : JSON.stringify(validExtraction);
        return { choices: [{ message: { content } }] };
      },
    },
  } as unknown as Env;

  const result = await readReceipt(env, new Uint8Array([1, 2, 3]).buffer, 'image/webp');

  assert.equal(calls, 2);
  assert.equal(result.attemptCount, 2);
  assert.deepEqual(result.verificationIssues, []);
});

test('OCR recovers a unique merchant-pattern number when its printed label is unreadable', async () => {
  const ticketNumber = '2026/934211-001000591';
  let prompt = '';
  const extraction = {
    ...validExtraction,
    ticketNumber,
    ticketNumberText: ticketNumber,
    purchaseDate: '2026-08-07',
    purchaseDateTime: '2026-08-07T08:39',
    purchaseDateText: '07/08/2026 08:39',
    totalCents: 174,
    totalText: 'TOTAL COMPRA: 1,74',
    rawText: `DINOSOL SUPERMERCADOS, S.L. CIF B61742565 9342-SD LOS REALEJOS Teléfono 900230230 Hora 08:39 ${ticketNumber} 07/08/2026 08:39 ARTICULO IMPORTE TOTAL COMPRA: 1,74`,
  };
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_TIMEOUT_MS: '5000',
    AI: {
      async run(_model: string, input: Record<string, unknown>) {
        prompt = String((input.messages as Array<{ role: string; content: string }>)[1]?.content || '');
        return { choices: [{ message: { content: JSON.stringify(extraction) } }] };
      },
    },
  } as unknown as Env;
  const profile = {
    version: 1 as const,
    enabled: true,
    headerSignatures: ['DINOSOL SUPERMERCADOS'],
    ticketNumberLabels: ['Documento'],
    ticketNumberHelp: 'Busca el número debajo de Documento.',
    ticketNumberExample: '2026/123456-00123456',
    ticketNumberPattern: 'AAAA/NNNNNN-NNNNNNNN[N]',
    dateLabels: ['Fecha', 'Hora'],
    totalLabels: ['TOTAL COMPRA'],
    ignoredTotalLabels: ['Subtotal'],
    ticketNumberRegion: 'header' as const,
    dateRegion: 'header' as const,
    totalRegion: 'footer' as const,
    dateFormat: 'DD/MM/AAAA',
    instructions: '',
    sampleCount: 3,
  };

  const result = await readReceipt(
    env,
    new Uint8Array([1, 2, 3]).buffer,
    'image/webp',
    [{ name: 'Hiperdino', aliases: ['Dinosol'], ocrProfile: profile }],
  );

  assert.equal(result.receipt.ticketNumber, ticketNumber);
  assert.equal(result.receipt.evidence?.ticketNumberText, ticketNumber);
  assert.deepEqual(result.verificationIssues, []);
  assert.match(prompt, /2026\/123456-00123456/);
  assert.match(prompt, /AAAA\/NNNNNN-NNNNNNNN\[N\]/);
  assert.match(prompt, /etiqueta del número está parcialmente ilegible/);
});

test('OCR merchant pattern replaces a verified identifier that uses the wrong syntax', async () => {
  const extraction = {
    isReceipt: true,
    confidence: 0.99,
    storeName: 'Echeide',
    headerText: 'ECHEIDE',
    ticketNumber: 'CAJA-003',
    ticketNumberText: 'Factura: CAJA-003',
    purchaseDate: '2026-08-12',
    purchaseDateTime: '2026-08-12T10:27',
    purchaseDateText: '12/08/26 - 10:27',
    totalCents: 600,
    totalText: 'Total 6,0€',
    currency: 'EUR',
    rawText: 'ECHEIDE\n8008 - 12/08/26 - 10:27\nTotal 6,0€',
  };
  const env = {
    OCR_MODE: 'workers-ai', OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct', OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_TIMEOUT_MS: '5000',
    AI: { async run() { return { choices: [{ message: { content: JSON.stringify(extraction) } }] }; } },
  } as unknown as Env;

  const result = await readReceipt(
    env,
    new Uint8Array([1, 2, 3]).buffer,
    'image/webp',
    [{
      name: 'Echeide', aliases: [],
      ocrProfile: {
        version: 1, enabled: true, headerSignatures: ['ECHEIDE'],
        ticketNumberLabels: ['Factura'], ticketNumberHelp: '',
        ticketNumberExample: '1234', ticketNumberPattern: 'NNNN',
        dateLabels: ['Factura'], totalLabels: ['Total'], ignoredTotalLabels: [],
        ticketNumberRegion: 'body', dateRegion: 'body', totalRegion: 'footer',
        dateFormat: 'DD/MM/AA', instructions: '', sampleCount: 3,
      },
    }],
  );

  assert.equal(result.receipt.ticketNumber, '8008');
  assert.equal(result.receipt.evidence?.ticketNumberText, '8008');
  assert.deepEqual(result.verificationIssues, []);
});

test('OCR does not recover an unlabeled merchant-pattern number when candidates conflict', async () => {
  const extraction = {
    ...validExtraction,
    ticketNumber: '',
    ticketNumberText: '',
    rawText: 'DINOSOL SUPERMERCADOS Fecha 06/08/2026 Hora 09:01 2026/934211-001000591 2026/934211-001000592 TOTAL COMPRA 15,92',
  };
  const env = {
    OCR_MODE: 'workers-ai', OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct', OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_TIMEOUT_MS: '5000',
    AI: { async run() { return { choices: [{ message: { content: JSON.stringify(extraction) } }] }; } },
  } as unknown as Env;
  const result = await readReceipt(
    env,
    new Uint8Array([1, 2, 3]).buffer,
    'image/webp',
    [{
      name: 'Hiperdino', aliases: ['Dinosol'],
      ocrProfile: {
        version: 1, enabled: true, headerSignatures: ['DINOSOL SUPERMERCADOS'],
        ticketNumberLabels: ['Documento'], ticketNumberHelp: '',
        ticketNumberExample: '2026/123456-00123456', dateLabels: ['Fecha'],
        ticketNumberPattern: 'AAAA/NNNNNN-NNNNNNNN[N]',
        totalLabels: ['TOTAL COMPRA'], ignoredTotalLabels: ['Subtotal'],
        ticketNumberRegion: 'header', dateRegion: 'header', totalRegion: 'footer',
        dateFormat: 'DD/MM/AAAA', instructions: '', sampleCount: 3,
      },
    }],
  );

  assert.equal(result.receipt.ticketNumber, '');
  assert.deepEqual(result.verificationIssues, []);
});

test('OCR reading reports attempts and duration after a definitive provider timeout', async () => {
  let calls = 0;
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_TIMEOUT_MS: '5000',
    AI: {
      async run() {
        calls += 1;
        throw new Error('OCR_PROVIDER_TIMEOUT');
      },
    },
  } as unknown as Env;

  await assert.rejects(
    () => readReceipt(env, new Uint8Array([1, 2, 3]).buffer, 'image/webp'),
    (caught: unknown) => caught instanceof OcrReadError &&
      caught.reason === 'OCR_PROVIDER_TIMEOUT' && caught.attemptCount === 2 && caught.durationMs >= 0,
  );
  assert.equal(calls, 2);
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
  assert.equal(receipt.totalCents, 1599);
  assert.deepEqual(verifyOcr(receipt), [
    'MISSING_TICKET_NUMBER_OR_TIME',
    'UNVERIFIED_DATE',
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

  const structuredReceipt = {
    isReceipt: true,
    storeName: 'Comercio Demo',
    purchaseDate: '2026-08-06',
    totalCents: 1592,
  };
  assert.equal(
    await providerResponseText({ response: structuredReceipt, usage: { total_tokens: 7436 } }),
    JSON.stringify(structuredReceipt),
  );
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
        ticketNumberHelp: '', ticketNumberExample: '', ticketNumberPattern: '',
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

test('OCR keeps the initial evidence when one focused region fails', async () => {
  let calls = 0;
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_TIMEOUT_MS: '5000',
    AI: {
      async run() {
        calls += 1;
        if (calls === 2) throw new Error('OCR_PROVIDER_TIMEOUT');
        const extraction = calls === 1 ? { ...validExtraction, confidence: 0.5 } : validExtraction;
        return { choices: [{ message: { content: JSON.stringify(extraction) } }] };
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

  const result = await readReceipt(env, new Uint8Array([1, 2, 3]).buffer, 'image/webp');

  assert.equal(calls, 3);
  assert.equal(result.attemptCount, 3);
  assert.equal(result.receipt.ticketNumber, validExtraction.ticketNumber);
  assert.deepEqual(result.verificationIssues, []);
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

test('OCR prompts use user-declared values only as candidates requiring visible evidence', async () => {
  let prompt = '';
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_TIMEOUT_MS: '5000',
    AI: {
      async run(_model: string, input: Record<string, unknown>) {
        const messages = input.messages as Array<{ role: string; content: string }>;
        prompt = messages.find((message) => message.role === 'user')?.content || '';
        return { choices: [{ message: { content: JSON.stringify(validExtraction) } }] };
      },
    },
  } as unknown as Env;

  await readReceipt(
    env,
    new Uint8Array([1, 2, 3]).buffer,
    'image/webp',
    [{ name: 'Hiperdino', aliases: ['Dinosol'] }],
    { storeName: 'Hiperdino', ticketNumber: '2026/934211-00100048', totalCents: 1592 },
  );

  assert.match(prompt, /Datos declarados por el usuario/);
  assert.match(prompt, /2026\/934211-00100048/);
  assert.match(prompt, /no evidencia ni valores garantizados/);
  assert.match(prompt, /devuelve siempre lo que esté literalmente impreso/);
});

test('confident non-receipt images are rejected after one model call', async () => {
  let calls = 0;
  let prompt = '';
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_TIMEOUT_MS: '5000',
    AI: {
      async run(_model: string, input: Record<string, unknown>) {
        calls += 1;
        const messages = input.messages as Array<{ role: string; content: string }>;
        prompt = messages.find((message) => message.role === 'user')?.content || '';
        return { choices: [{ message: { content: JSON.stringify({
          isReceipt: false,
          confidence: 0.96,
          storeName: '',
          headerText: '',
          ticketNumber: '',
          purchaseDate: '',
          totalCents: 0,
          currency: 'EUR',
          rawText: '',
        }) } }] };
      },
    },
  } as unknown as Env;

  const result = await readReceipt(env, new Uint8Array([1, 2, 3]).buffer, 'image/webp');

  assert.equal(calls, 1);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.receipt.isReceipt, false);
  assert.deepEqual(result.verificationIssues, []);
  assert.match(prompt, /fotografía\s+personal, paisaje, objeto/i);
});

test('fast preflight rejects an obvious non-ticket before Llama OCR', async () => {
  const models: string[] = [];
  let preflightInput: Record<string, unknown> = {};
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    OCR_PREFLIGHT_MODEL: '@cf/moondream/moondream3.1-9B-A2B',
    OCR_PREFLIGHT_TIMEOUT_MS: '5000',
    AI: {
      async run(model: string, input: Record<string, unknown>) {
        models.push(model);
        preflightInput = input;
        return { answer: 'NO_TICKET' };
      },
    },
  } as unknown as Env;

  const result = await readReceipt(env, new Uint8Array([1, 2, 3]).buffer, 'image/webp');

  assert.deepEqual(models, ['@cf/moondream/moondream3.1-9B-A2B']);
  assert.equal(result.receipt.isReceipt, false);
  assert.equal(result.model, '@cf/moondream/moondream3.1-9B-A2B');
  assert.equal(result.attemptCount, 1);
  assert.equal(preflightInput.task, 'query');
  assert.equal(preflightInput.reasoning, false);
  assert.equal(preflightInput.max_tokens, 8);
});

test('assisted scan declarations force full OCR after a negative preflight', async () => {
  const models: string[] = [];
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_PREFLIGHT_MODEL: '@cf/moondream/moondream3.1-9B-A2B',
    OCR_PREFLIGHT_TIMEOUT_MS: '5000',
    AI: {
      async run(model: string) {
        models.push(model);
        if (model.includes('moondream')) return { answer: 'NO_TICKET' };
        return { choices: [{ message: { content: JSON.stringify(validExtraction) } }] };
      },
    },
  } as unknown as Env;

  const result = await readReceipt(
    env,
    new Uint8Array([1, 2, 3]).buffer,
    'image/webp',
    [{ name: 'Echeide', aliases: ['Echeide Soluciones'] }],
    { storeName: 'Echeide', ticketNumber: '8113', totalCents: 2500 },
  );

  assert.deepEqual(models, [
    '@cf/moondream/moondream3.1-9B-A2B',
    '@cf/meta/llama-3.2-11b-vision-instruct',
  ]);
  assert.equal(result.receipt.isReceipt, true);
  assert.equal(result.attemptCount, 2);
});

test('uncertain preflight fails open and lets Llama inspect the image', async () => {
  const models: string[] = [];
  const env = {
    OCR_MODE: 'workers-ai',
    OCR_PROVIDER: 'workers-ai',
    OCR_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    OCR_WORKERS_AI_FORMAT: 'chat',
    OCR_PREFLIGHT_MODEL: '@cf/moondream/moondream3.1-9B-A2B',
    OCR_PREFLIGHT_TIMEOUT_MS: '5000',
    AI: {
      async run(model: string) {
        models.push(model);
        if (model.includes('moondream')) return { answer: 'DUDA' };
        return { choices: [{ message: { content: JSON.stringify(validExtraction) } }] };
      },
    },
  } as unknown as Env;

  const result = await readReceipt(env, new Uint8Array([1, 2, 3]).buffer, 'image/webp');

  assert.deepEqual(models, [
    '@cf/moondream/moondream3.1-9B-A2B',
    '@cf/meta/llama-3.2-11b-vision-instruct',
  ]);
  assert.equal(result.receipt.isReceipt, true);
  assert.equal(result.attemptCount, 2);
});
