import { hasVerifiedPurchaseTime, type OcrReceipt } from '../domain/receipt';
import { profileHasGuidance } from '../domain/ocr-profile';
import { findMatchingStore, type StoreIdentity } from '../domain/store';
import { prepareOcrRegions } from '../platform/image';
import type { Env } from '../types';
import { createOcrProvider } from './ocr-provider';

type OcrEvidence = {
  ticketNumberText?: string;
  purchaseDateText?: string;
  totalText?: string;
};

export type OcrReadResult = {
  receipt: OcrReceipt;
  provider: string;
  model: string;
  attemptCount: number;
  durationMs: number;
  verificationIssues: string[];
};

function parseJsonObject(value: string): Record<string, unknown> {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('OCR_INVALID_JSON');
  return JSON.parse(value.slice(start, end + 1)) as Record<string, unknown>;
}

export function normalizeOcr(value: Record<string, unknown>): OcrReceipt {
  const confidence = Number(value.confidence);
  const total = Number(value.totalCents);
  const totalText = String(value.totalText || '').trim().slice(0, 300);
  const normalizedTotal = Number.isInteger(total) && total > 0 ? total : centsFromEvidence(totalText);
  const ticketNumberText = String(value.ticketNumberText || '').trim().slice(0, 300);
  const purchaseDateText = String(value.purchaseDateText || '').trim().slice(0, 300);
  const rawPurchaseDate = String(value.purchaseDate || '').trim();
  const evidencedDate = isoDateFromEvidence(purchaseDateText, rawPurchaseDate);
  const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(rawPurchaseDate)
    ? rawPurchaseDate
    : evidencedDate || rawPurchaseDate;
  const evidencedTicketNumber = ticketNumberFromEvidence(ticketNumberText);
  const rawCurrency = String(value.currency || 'EUR').trim().toUpperCase();
  const currency = ['€', 'EURO', 'EUROS'].includes(rawCurrency) || !/^[A-Z]{3}$/.test(rawCurrency)
    ? 'EUR'
    : rawCurrency;
  const purchaseDateTime = String(value.purchaseDateTime || '').trim();
  const normalizedDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(purchaseDateTime)
    ? purchaseDateTime
    : /^\d{2}:\d{2}$/.test(purchaseDateTime) && /^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)
      ? `${normalizedDate}T${purchaseDateTime}`
      : undefined;
  return {
    isReceipt: value.isReceipt === true,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    storeName: String(value.storeName || '').trim(),
    headerText: String(value.headerText || '').trim().slice(0, 2_000),
    ticketNumber: evidencedTicketNumber || String(value.ticketNumber || '').trim(),
    purchaseDate: normalizedDate,
    purchaseDateTime: normalizedDateTime,
    totalCents: normalizedTotal && normalizedTotal > 0 ? normalizedTotal : undefined,
    currency,
    rawText: String(value.rawText || '').slice(0, 8_000),
    evidence: {
      ticketNumberText,
      purchaseDateText,
      totalText,
    },
  };
}

function compactIdentifier(value: string): string {
  return value.normalize('NFKD').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function hasVerifiedTicketNumber(receipt: OcrReceipt): boolean {
  return Boolean(receipt.ticketNumber) && compactIdentifier(receipt.evidence?.ticketNumberText || '')
    .includes(compactIdentifier(receipt.ticketNumber || ''));
}

function preferVerifiedIdentity(receipt: OcrReceipt): OcrReceipt {
  if (!receipt.ticketNumber || hasVerifiedTicketNumber(receipt) || !hasVerifiedPurchaseTime(receipt)) return receipt;
  return { ...receipt, ticketNumber: '' };
}

function ticketNumberFromEvidence(value: string): string | null {
  const labelled = /(?:documento|ticket|factura|recibo|transacci[oó]n|operaci[oó]n|folio|n[º°o]\.?)\s*[:#-]*\s+(.+)/i.exec(value);
  if (!labelled) return null;
  const candidates = (labelled[1] || '').match(/[A-Z0-9][A-Z0-9./-]{3,}/gi) || [];
  return candidates.sort((left, right) => compactIdentifier(right).length - compactIdentifier(left).length)[0] || null;
}

function centsFromEvidence(value: string): number | null {
  const matches = [...value.matchAll(/(\d{1,3}(?:[.\s]\d{3})*|\d+)[,.](\d{2})/g)];
  const match = matches.at(-1);
  if (!match) return null;
  const units = Number(match[1]!.replace(/[.\s]/g, ''));
  const cents = Number(match[2]!);
  return Number.isSafeInteger(units) ? (units * 100) + cents : null;
}

function isoDateFromEvidence(value: string, expectedDate: string): string | null {
  const iso = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(value);
  const european = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/.exec(value);
  const shortEuropean = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b/.exec(value);
  const parts: [number, number, number] | null = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : european
      ? [Number(european[3]), Number(european[2]), Number(european[1])]
      : shortEuropean && /^\d{4}-/.test(expectedDate)
        ? [Number(expectedDate.slice(0, 2) + shortEuropean[3]), Number(shortEuropean[2]), Number(shortEuropean[1])]
      : null;
  if (!parts) return null;
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function verifyOcr(receipt: OcrReceipt): string[] {
  const issues: string[] = [];
  if (!receipt.isReceipt) return issues;
  const evidence = receipt.evidence || {};
  if (!receipt.ticketNumber) {
    if (!hasVerifiedPurchaseTime(receipt)) issues.push('MISSING_TICKET_NUMBER_OR_TIME');
  } else if (!hasVerifiedTicketNumber(receipt)) {
    issues.push('UNVERIFIED_TICKET_NUMBER');
  }
  if (!receipt.purchaseDate) issues.push('MISSING_DATE');
  else if (isoDateFromEvidence(evidence.purchaseDateText || '', receipt.purchaseDate) !== receipt.purchaseDate) {
    issues.push('UNVERIFIED_DATE');
  }
  if (!receipt.totalCents) issues.push('MISSING_TOTAL');
  else if (centsFromEvidence(evidence.totalText || '') !== receipt.totalCents) {
    issues.push('UNVERIFIED_TOTAL');
  }
  return issues;
}

function authorizedStoreReference(stores: StoreIdentity[]): string {
  const entries: string[] = [];
  let length = 2;
  for (const store of stores.slice(0, 80)) {
    const profile = store.ocrProfile && profileHasGuidance(store.ocrProfile)
      ? {
          headerSignatures: store.ocrProfile.headerSignatures.slice(0, 8),
          ticketNumber: {
            labels: store.ocrProfile.ticketNumberLabels.slice(0, 8),
            region: store.ocrProfile.ticketNumberRegion,
          },
          purchaseDate: {
            labels: store.ocrProfile.dateLabels.slice(0, 8),
            region: store.ocrProfile.dateRegion,
            format: store.ocrProfile.dateFormat,
          },
          total: {
            labels: store.ocrProfile.totalLabels.slice(0, 8),
            ignore: store.ocrProfile.ignoredTotalLabels.slice(0, 10),
            region: store.ocrProfile.totalRegion,
          },
          instructions: store.ocrProfile.instructions.slice(0, 600),
        }
      : undefined;
    const entry = JSON.stringify({
      name: store.name,
      aliases: (Array.isArray(store.aliases) ? store.aliases : []).slice(0, 12),
      ...(profile ? { profile } : {}),
    });
    if (length + entry.length + entries.length > 6_000) break;
    entries.push(entry);
    length += entry.length;
  }
  return `[${entries.join(',')}]`;
}

function extractionPrompt(storeReference: string, retry: boolean): string {
  return `Analiza la imagen como un ticket de compra y devuelve exclusivamente un objeto JSON válido con:
isReceipt (boolean), confidence (0..1), storeName, headerText, ticketNumber,
ticketNumberText, purchaseDate (YYYY-MM-DD), purchaseDateTime (YYYY-MM-DDTHH:mm o cadena vacía),
purchaseDateText, totalCents (entero), totalText, currency y rawText.

ticketNumberText, purchaseDateText y totalText deben ser transcripciones literales y breves de las
líneas visibles que demuestran cada valor. Si no puedes ver esa evidencia, deja el valor y su texto vacíos.
No deduzcas, completes ni inventes caracteres.${retry ? '\nEsta es una segunda comprobación: céntrate especialmente en FECHA, TOTAL COMPRA y número de DOCUMENTO/TICKET.' : ''}

Si el ticket no imprime un número identificador, deja ticketNumber y ticketNumberText vacíos y extrae
obligatoriamente la fecha y hora impresas en purchaseDateTime y purchaseDateText. La combinación de
comercio, fecha, hora e importe se utilizará entonces como identificación alternativa.

Reglas para storeName:
- Es el comercio emisor, nunca un producto, marca del listado, eslogan, pago ni cliente.
- Búscalo solo en cabecera o bloque fiscal, antes del primer artículo.
- headerText debe transcribir únicamente esa cabecera o bloque fiscal.
- Comercios autorizados y alias: ${storeReference}.
- Algunos comercios incluyen un profile aprendido de ejemplos verificados. Úsalo solo para localizar
  etiquetas y zonas después de comprobar una firma visible del comercio; nunca copies valores del perfil.
- Si coincide claramente, devuelve exactamente su name; sin evidencia visible, déjalo vacío.

Usa exclusivamente la fecha impresa. El total es el importe final pagado, no subtotal, ahorro ni efectivo entregado.
Expresa el importe en céntimos y transcribe en rawText las líneas relevantes de cabecera, documento, fecha y total.`;
}

function regionPrompt(storeReference: string, region: 'header' | 'totals'): string {
  const focus = region === 'header'
    ? `Esta imagen muestra la CABECERA y primera parte del ticket. Localiza el comercio, la línea de
DOCUMENTO/TICKET/FACTURA y la FECHA/HORA. ticketNumber debe ser el valor completo que aparece después
de una etiqueta identificadora como Documento, Ticket, Factura, Recibo, Folio o Transacción. Un CIF/NIF,
dirección, centro, caja, vendedor o código de tienda NO son el número del ticket. ticketNumberText debe
incluir literalmente la etiqueta que identifica ese número.`
    : `Esta imagen muestra la parte INFERIOR del ticket. Localiza el TOTAL COMPRA o importe final
pagado. No uses subtotales, ahorro, cambio, efectivo entregado ni importes de líneas de producto.`;
  return `${focus}

Devuelve exclusivamente JSON válido con: isReceipt, confidence, storeName, headerText,
ticketNumber, ticketNumberText, purchaseDate (YYYY-MM-DD), purchaseDateTime, purchaseDateText,
totalCents (entero), totalText, currency y rawText.

Los campos *Text deben ser transcripciones literales de la imagen. Deja vacíos los valores que no
aparezcan en este recorte; no deduzcas ni inventes caracteres. Comercios autorizados: ${storeReference}.`;
}

function mergeRegionResults(
  initial: OcrReceipt,
  header: OcrReceipt,
  totals: OcrReceipt,
): OcrReceipt {
  return {
    isReceipt: initial.isReceipt || header.isReceipt || totals.isReceipt,
    confidence: Math.min(initial.confidence, header.confidence, totals.confidence),
    storeName: header.storeName || initial.storeName || '',
    headerText: header.headerText || initial.headerText || '',
    ticketNumber: header.ticketNumber || initial.ticketNumber || '',
    purchaseDate: header.purchaseDate || initial.purchaseDate || '',
    purchaseDateTime: header.purchaseDateTime || initial.purchaseDateTime,
    totalCents: totals.totalCents || initial.totalCents,
    currency: totals.currency || initial.currency || 'EUR',
    rawText: [header.rawText, totals.rawText, initial.rawText].filter(Boolean).join('\n').slice(0, 8_000),
    evidence: {
      ticketNumberText: header.evidence?.ticketNumberText || initial.evidence?.ticketNumberText || '',
      purchaseDateText: header.evidence?.purchaseDateText || initial.evidence?.purchaseDateText || '',
      totalText: totals.evidence?.totalText || initial.evidence?.totalText || '',
    },
  };
}

export async function readReceipt(
  env: Env,
  bytes: ArrayBuffer,
  contentType = 'image/jpeg',
  authorizedStores: StoreIdentity[] = [],
): Promise<OcrReadResult> {
  if (env.OCR_MODE === 'mock') {
    const today = new Date().toISOString().slice(0, 10);
    return {
      receipt: {
        isReceipt: true,
        confidence: 0.93,
        storeName: 'Tienda asociada',
        headerText: 'Tienda asociada',
        ticketNumber: `DEMO-${Date.now().toString(36).toUpperCase()}`,
        purchaseDate: today,
        purchaseDateTime: new Date().toISOString().slice(0, 16),
        totalCents: 7500,
        currency: 'EUR',
        rawText: `Fecha ${today}\nTOTAL 75,00 EUR`,
        evidence: { ticketNumberText: 'DEMO', purchaseDateText: today, totalText: 'TOTAL 75,00 EUR' },
      },
      provider: 'mock', model: 'mock', attemptCount: 1, durationMs: 0, verificationIssues: [],
    };
  }

  const provider = createOcrProvider(env);
  const storeReference = authorizedStoreReference(authorizedStores);
  const startedAt = Date.now();
  let response = await provider.extract({
    bytes, contentType, prompt: extractionPrompt(storeReference, false),
  });
  let receipt = preferVerifiedIdentity(normalizeOcr(parseJsonObject(response.text)));
  let issues = verifyOcr(receipt);
  let attemptCount = 1;
  let durationMs = response.durationMs;

  if (receipt.confidence < 0.75 || !receipt.isReceipt || issues.length > 0) {
    const matchedStore = findMatchingStore(authorizedStores, receipt);
    const focusedStoreReference = authorizedStoreReference(matchedStore ? [matchedStore] : authorizedStores);
    const regions = await prepareOcrRegions(env, bytes);
    const [headerResponse, totalsResponse] = await Promise.all([
      provider.extract({
        bytes: regions.header, contentType: 'image/webp', prompt: regionPrompt(focusedStoreReference, 'header'),
      }),
      provider.extract({
        bytes: regions.totals, contentType: 'image/webp', prompt: regionPrompt(focusedStoreReference, 'totals'),
      }),
    ]);
    receipt = preferVerifiedIdentity(mergeRegionResults(
      receipt,
      normalizeOcr(parseJsonObject(headerResponse.text)),
      normalizeOcr(parseJsonObject(totalsResponse.text)),
    ));
    issues = verifyOcr(receipt);
    attemptCount = 3;
    durationMs = Date.now() - startedAt;
  }

  return {
    receipt,
    provider: response.provider,
    model: response.model,
    attemptCount,
    durationMs,
    verificationIssues: issues,
  };
}
