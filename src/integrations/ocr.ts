import {
  hasVerifiedPurchaseTime,
  isValidPurchaseDateTime,
  purchaseTimeFromEvidence,
  type OcrReceipt,
} from '../domain/receipt';
import { profileHasGuidance } from '../domain/ocr-profile';
import { findMatchingStore, type StoreIdentity } from '../domain/store';
import { prepareOcrRegions } from '../platform/image';
import type { Env } from '../types';
import { createOcrProvider, imageDataUrl, providerResponseText } from './ocr-provider';

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

export type ReceiptOcrHints = {
  storeName?: string;
  ticketNumber: string;
  totalCents: number;
  currency?: string;
};

type ReceiptPreflight = {
  decision: 'TICKET' | 'NO_TICKET' | 'UNCERTAIN';
  durationMs: number;
  model: string;
};

function preflightTimeoutMs(env: Env): number {
  const configured = Number(env.OCR_PREFLIGHT_TIMEOUT_MS);
  return Number.isFinite(configured) ? Math.max(1_000, Math.min(10_000, configured)) : 5_000;
}

async function classifyReceiptImage(
  env: Env,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<ReceiptPreflight | null> {
  const model = String(env.OCR_PREFLIGHT_MODEL || '').trim();
  if (!model) return null;
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (env.AI as unknown as { run: Function }).run(model, {
        task: 'query',
        image: imageDataUrl(bytes, contentType),
        question: `Clasifica la imagen. Responde exclusivamente con una de estas palabras:
TICKET: se ve claramente un ticket o recibo de compra.
NO_TICKET: se ve claramente una foto personal, persona, paisaje, animal, objeto, portátil,
pantalla, cartel u otra imagen ajena a un ticket.
DUDA: parece un documento, papel o imagen borrosa y no puedes descartarlo con seguridad.
No expliques la respuesta. Ante cualquier duda responde DUDA.`,
        reasoning: false,
        stream: false,
        temperature: 0,
        max_tokens: 8,
      }) as Promise<unknown>,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('OCR_PREFLIGHT_TIMEOUT')), preflightTimeoutMs(env));
      }),
    ]);
    const answer = (await providerResponseText(result)).trim().toUpperCase();
    const decision = /\bNO[_\s-]?TICKET\b/.test(answer)
      ? 'NO_TICKET'
      : /^TICKET\b/.test(answer)
        ? 'TICKET'
        : 'UNCERTAIN';
    return { decision, durationMs: Date.now() - startedAt, model };
  } catch (caught) {
    console.warn('OCR preflight failed open', caught);
    return { decision: 'UNCERTAIN', durationMs: Date.now() - startedAt, model };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('OCR_INVALID_JSON');
  const candidate = value.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch (caught) {
    // Some vision models return otherwise valid JSON with literal newlines or tabs
    // inside rawText/evidence strings. Escape only control characters that occur
    // inside JSON strings so malformed structure still fails normally.
    let repaired = '';
    let insideString = false;
    let escaped = false;
    for (const character of candidate) {
      if (escaped) {
        repaired += character;
        escaped = false;
        continue;
      }
      if (insideString && character === '\\') {
        repaired += character;
        escaped = true;
        continue;
      }
      if (character === '"') {
        repaired += character;
        insideString = !insideString;
        continue;
      }
      const code = character.charCodeAt(0);
      if (insideString && code <= 0x1f) {
        if (character === '\n') repaired += '\\n';
        else if (character === '\r') repaired += '\\r';
        else if (character === '\t') repaired += '\\t';
        else if (character === '\b') repaired += '\\b';
        else if (character === '\f') repaired += '\\f';
        else repaired += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      repaired += character;
    }
    try {
      return JSON.parse(repaired) as Record<string, unknown>;
    } catch {
      throw caught;
    }
  }
}

export function normalizeOcr(value: Record<string, unknown>): OcrReceipt {
  const confidence = Number(value.confidence);
  const total = Number(value.totalCents);
  const totalText = String(value.totalText || '').trim().slice(0, 300);
  const ticketNumberText = String(value.ticketNumberText || '').trim().slice(0, 300);
  const purchaseDateText = String(value.purchaseDateText || '').trim().slice(0, 300);
  const rawText = String(value.rawText || '').slice(0, 8_000);
  const totalFromFields = Number.isInteger(total) && total > 0 ? total : centsFromEvidence(totalText);
  const rawTotalText = totalEvidenceFromRaw(rawText, totalFromFields);
  const normalizedTotal = totalFromFields || centsFromEvidence(rawTotalText);
  const verifiedTotalText = normalizedTotal && centsFromEvidence(totalText) === normalizedTotal
    ? totalText
    : rawTotalText || totalText;
  const rawPurchaseDate = String(value.purchaseDate || '').trim();
  const evidencedDate = isoDateFromEvidence(purchaseDateText, rawPurchaseDate);
  const literalDate = isoDateFromEvidence(rawPurchaseDate, rawPurchaseDate);
  // The literal printed line wins when a model converts an ambiguous Spanish
  // date to the wrong ISO month/day order.
  const normalizedDate = evidencedDate || literalDate || rawPurchaseDate;
  const rawPurchaseDateText = dateTimeEvidenceFromRaw(rawText, normalizedDate);
  const verifiedPurchaseDateText = isoDateFromEvidence(purchaseDateText, normalizedDate) === normalizedDate
    ? purchaseDateText
    : rawPurchaseDateText || purchaseDateText;
  const directTicketNumber = ticketNumberFromEvidence(ticketNumberText);
  const rawTicketNumber = directTicketNumber ? null : ticketNumberFromEvidence(rawText.slice(0, 2_000));
  const evidencedTicketNumber = directTicketNumber || rawTicketNumber;
  const verifiedTicketNumberText = directTicketNumber
    ? ticketNumberText
    : rawTicketNumber ? `Documento ${rawTicketNumber}` : ticketNumberText;
  const rawCurrency = String(value.currency || 'EUR').trim().toUpperCase();
  const currency = ['€', 'EURO', 'EUROS'].includes(rawCurrency) || !/^[A-Z]{3}$/.test(rawCurrency)
    ? 'EUR'
    : rawCurrency;
  const purchaseDateTime = String(value.purchaseDateTime || '').trim();
  const evidencedTime = purchaseTimeFromEvidence(verifiedPurchaseDateText);
  const timeOnly = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(purchaseDateTime);
  const normalizedTimeOnly = timeOnly
    ? `${String(Number(timeOnly[1])).padStart(2, '0')}:${timeOnly[2]}`
    : '';
  const modelDateTime = isValidPurchaseDateTime(purchaseDateTime, normalizedDate)
    ? purchaseDateTime
    : normalizedTimeOnly && /^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)
      ? `${normalizedDate}T${normalizedTimeOnly}`
      : undefined;
  // Keep a time only when the literal evidence contains the same value. This
  // prevents a plausible but invented model time from affecting eligibility.
  const normalizedDateTime = modelDateTime && evidencedTime === modelDateTime.slice(11, 16)
    ? modelDateTime
    : evidencedTime && /^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)
      ? `${normalizedDate}T${evidencedTime}`
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
    rawText,
    evidence: {
      ticketNumberText: verifiedTicketNumberText,
      purchaseDateText: verifiedPurchaseDateText,
      totalText: verifiedTotalText,
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
  const labelled = /(?:^|\b)(?:documento|ticket|factura|recibo|transacci[oó]n|operaci[oó]n|folio|n[º°o]\.?)\s*[:#-]*\s+(.+)/i.exec(value);
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

function totalEvidenceFromRaw(value: string, expectedCents: number | null): string {
  const matches = [...value.matchAll(/(?:TOTAL(?:\s+COMPRA)?|IMPORTE\s+TOTAL)\s*:?\s*(\d{1,3}(?:[.\s]\d{3})*|\d+)[,.](\d{2})/gi)];
  const matching = expectedCents
    ? matches.find((match) => centsFromEvidence(match[0]) === expectedCents)
    : matches.at(-1);
  return matching?.[0]?.trim().slice(0, 300) || '';
}

function yearFromEvidence(value: string, expectedDate: string): number {
  const year = Number(value);
  if (value.length === 4) return year;
  if (/^\d{4}-/.test(expectedDate)) return Number(`${expectedDate.slice(0, 2)}${value}`);
  return 2_000 + year;
}

function spanishMonthNumber(value: string): number | null {
  const key = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().slice(0, 3);
  const months: Record<string, number> = {
    ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
    jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
  };
  return months[key] || null;
}

function isoDateFromEvidence(value: string, expectedDate: string): string | null {
  const iso = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(value);
  const european = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/.exec(value);
  const shortEuropean = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b/.exec(value);
  const textual = /\b(\d{1,2})\s+(?:de\s+)?(ene(?:ro)?|feb(?:rero)?|mar(?:zo)?|abr(?:il)?|may(?:o)?|jun(?:io)?|jul(?:io)?|ago(?:sto)?|sep(?:t(?:iembre)?)?|set(?:iembre)?|oct(?:ubre)?|nov(?:iembre)?|dic(?:iembre)?)\.?\s+(?:de\s+)?(\d{2,4})\b/i.exec(value);
  const textualMonth = textual ? spanishMonthNumber(textual[2]!) : null;
  const parts: [number, number, number] | null = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : european
      ? [Number(european[3]), Number(european[2]), Number(european[1])]
      : shortEuropean
        ? [yearFromEvidence(shortEuropean[3]!, expectedDate), Number(shortEuropean[2]), Number(shortEuropean[1])]
      : textual && textualMonth
        ? [yearFromEvidence(textual[3]!, expectedDate), textualMonth, Number(textual[1])]
      : null;
  if (!parts) return null;
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateTimeEvidenceFromRaw(value: string, expectedDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)) return '';
  const dates = [
    ...value.matchAll(/\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/g),
    ...value.matchAll(/\b\d{1,2}\s+(?:de\s+)?(?:ene(?:ro)?|feb(?:rero)?|mar(?:zo)?|abr(?:il)?|may(?:o)?|jun(?:io)?|jul(?:io)?|ago(?:sto)?|sep(?:t(?:iembre)?)?|set(?:iembre)?|oct(?:ubre)?|nov(?:iembre)?|dic(?:iembre)?)\.?\s+(?:de\s+)?\d{2,4}\b/gi),
  ].sort((left, right) => (left.index || 0) - (right.index || 0));
  const candidates = dates
    .filter((match) => isoDateFromEvidence(match[0], expectedDate) === expectedDate)
    .map((match) => value.slice(Math.max(0, (match.index || 0) - 24), Math.min(value.length, (match.index || 0) + match[0].length + 48)).trim());
  return candidates.find((candidate) => purchaseTimeFromEvidence(candidate))
    || candidates[0]
    || '';
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

function declaredReceiptReference(hints?: ReceiptOcrHints): string {
  if (!hints) return '';
  return `

Datos declarados por el usuario antes de fotografiar el ticket:
${JSON.stringify({
    ...(hints.storeName ? { storeName: hints.storeName } : {}),
    ticketNumber: hints.ticketNumber,
    totalCents: hints.totalCents,
    currency: hints.currency || 'EUR',
  })}
Son candidatos que debes comprobar contra la imagen, no evidencia ni valores garantizados. Úsalos para
localizar mejor las líneas correspondientes, pero devuelve siempre lo que esté literalmente impreso. Si
la declaración no coincide con la fotografía, conserva el valor visible y su transcripción literal.`;
}

function extractionPrompt(storeReference: string, retry: boolean, hints?: ReceiptOcrHints): string {
  return `Analiza la imagen como un ticket de compra y devuelve exclusivamente un objeto JSON válido con:
isReceipt (boolean), confidence (0..1), storeName, headerText, ticketNumber,
ticketNumberText, purchaseDate (YYYY-MM-DD), purchaseDateTime (YYYY-MM-DDTHH:mm o cadena vacía),
purchaseDateText, totalCents (entero), totalText, currency y rawText.

Antes de extraer datos, decide si la imagen es realmente un ticket o recibo de compra. Una fotografía
personal, paisaje, objeto, captura de pantalla, cartel, documento genérico o imagen sin estructura de
ticket debe devolver isReceipt=false con la confianza de esa clasificación. En ese caso deja vacíos los
demás campos y no intentes reinterpretar elementos de la imagen como comercio, fecha o importe.

ticketNumberText, purchaseDateText y totalText deben ser transcripciones literales y breves de las
líneas visibles que demuestran cada valor. Si no puedes ver esa evidencia, deja el valor y su texto vacíos.
No deduzcas, completes ni inventes caracteres.${retry ? '\nEsta es una segunda comprobación: céntrate especialmente en FECHA, TOTAL COMPRA y número de DOCUMENTO/TICKET.' : ''}

Los tickets son principalmente españoles: interpreta las fechas numéricas ambiguas en orden día/mes/año
(por ejemplo, 06/08/2026 es 6 de agosto de 2026), aunque purchaseDate debe devolverse como YYYY-MM-DD.
Acepta también el año con dos cifras y meses escritos en español. Normaliza la hora visible a HH:mm en
formato de 24 horas; si la hora no aparece literalmente, deja purchaseDateTime vacío.

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
Expresa el importe en céntimos y transcribe en rawText las líneas relevantes de cabecera, documento, fecha y total.${declaredReceiptReference(hints)}`;
}

function regionPrompt(storeReference: string, region: 'header' | 'totals', hints?: ReceiptOcrHints): string {
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
aparezcan en este recorte; no deduzcas ni inventes caracteres. Interpreta las fechas numéricas en orden
español día/mes/año y devuelve purchaseDate como YYYY-MM-DD. Conserva la hora solo si aparece impresa,
normalizada a HH:mm. Comercios autorizados: ${storeReference}.${declaredReceiptReference(hints)}`;
}

function mergeRegionResults(
  initial: OcrReceipt,
  header: OcrReceipt,
  totals: OcrReceipt,
): OcrReceipt {
  return normalizeOcr({
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
    ticketNumberText: header.evidence?.ticketNumberText || initial.evidence?.ticketNumberText || '',
    purchaseDateText: header.evidence?.purchaseDateText || initial.evidence?.purchaseDateText || '',
    totalText: totals.evidence?.totalText || initial.evidence?.totalText || '',
  });
}

export async function readReceipt(
  env: Env,
  bytes: ArrayBuffer,
  contentType = 'image/jpeg',
  authorizedStores: StoreIdentity[] = [],
  hints?: ReceiptOcrHints,
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
  const preflight = await classifyReceiptImage(env, bytes, contentType);
  if (preflight?.decision === 'NO_TICKET') {
    return {
      receipt: normalizeOcr({
        isReceipt: false,
        confidence: 0.99,
        storeName: '',
        headerText: '',
        ticketNumber: '',
        purchaseDate: '',
        totalCents: 0,
        currency: 'EUR',
        rawText: '',
      }),
      provider: 'workers-ai',
      model: preflight.model,
      attemptCount: 1,
      durationMs: preflight.durationMs,
      verificationIssues: [],
    };
  }
  const preflightCalls = preflight ? 1 : 0;
  let response = await provider.extract({
    bytes, contentType, prompt: extractionPrompt(storeReference, false, hints),
  });
  let receipt = preferVerifiedIdentity(normalizeOcr(parseJsonObject(response.text)));
  let issues = verifyOcr(receipt);
  let attemptCount = preflightCalls + 1;
  let durationMs = preflight ? Date.now() - startedAt : response.durationMs;

  // A confident negative classification must not trigger the expensive header and totals passes.
  // Uncertain negatives still get the focused verification to avoid rejecting a poorly photographed receipt.
  if (!receipt.isReceipt && receipt.confidence >= 0.8) {
    return {
      receipt,
      provider: response.provider,
      model: response.model,
      attemptCount,
      durationMs,
      verificationIssues: [],
    };
  }

  if (receipt.confidence < 0.75 || !receipt.isReceipt || issues.length > 0) {
    const matchedStore = findMatchingStore(authorizedStores, receipt);
    const declaredStore = hints?.storeName
      ? authorizedStores.find((store) => store.name === hints.storeName)
      : undefined;
    const focusedStoreReference = authorizedStoreReference(
      matchedStore ? [matchedStore] : declaredStore ? [declaredStore] : authorizedStores,
    );
    const regions = await prepareOcrRegions(env, bytes);
    const [headerResponse, totalsResponse] = await Promise.all([
      provider.extract({
        bytes: regions.header, contentType: 'image/webp', prompt: regionPrompt(focusedStoreReference, 'header', hints),
      }),
      provider.extract({
        bytes: regions.totals, contentType: 'image/webp', prompt: regionPrompt(focusedStoreReference, 'totals', hints),
      }),
    ]);
    receipt = preferVerifiedIdentity(mergeRegionResults(
      receipt,
      normalizeOcr(parseJsonObject(headerResponse.text)),
      normalizeOcr(parseJsonObject(totalsResponse.text)),
    ));
    issues = verifyOcr(receipt);
    attemptCount = preflightCalls + 3;
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
