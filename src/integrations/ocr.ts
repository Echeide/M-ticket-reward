import type { OcrReceipt } from '../domain/receipt';
import type { Env } from '../types';

function parseJsonObject(value: string): Record<string, unknown> {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('OCR_INVALID_JSON');
  return JSON.parse(value.slice(start, end + 1)) as Record<string, unknown>;
}

function normalizeOcr(value: Record<string, unknown>): OcrReceipt {
  const confidence = Number(value.confidence);
  const total = Number(value.totalCents);
  return {
    isReceipt: value.isReceipt === true,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    storeName: String(value.storeName || '').trim(),
    ticketNumber: String(value.ticketNumber || '').trim(),
    purchaseDate: String(value.purchaseDate || '').trim(),
    totalCents: Number.isInteger(total) ? total : undefined,
    currency: String(value.currency || 'EUR').trim().toUpperCase(),
    rawText: String(value.rawText || '').slice(0, 8_000),
  };
}

export async function readReceipt(
  env: Env,
  bytes: ArrayBuffer,
  _contentType = 'image/jpeg',
): Promise<OcrReceipt> {
  if (env.OCR_MODE === 'mock') {
    return {
      isReceipt: true,
      confidence: 0.93,
      storeName: 'Tienda asociada',
      ticketNumber: `DEMO-${Date.now().toString(36).toUpperCase()}`,
      purchaseDate: new Date().toISOString().slice(0, 10),
      totalCents: 7500,
      currency: 'EUR',
      rawText: 'Resultado OCR simulado para desarrollo local',
    };
  }

  const prompt = `Analiza la imagen. Decide si es un ticket de compra y devuelve solo JSON con:
isReceipt (boolean), confidence (0..1), storeName, ticketNumber, purchaseDate (YYYY-MM-DD),
totalCents (entero), currency y rawText. No inventes valores ilegibles.`;
  const result = (await (env.AI as unknown as { run: Function }).run(env.OCR_MODEL, {
    task: 'query',
    // The Workers AI binding currently validates image input as byte values,
    // even though the catalog schema also documents data-URI strings.
    image: Array.from(new Uint8Array(bytes)),
    question: prompt,
    reasoning: false,
    temperature: 0.1,
    max_tokens: 1_024,
  })) as Record<string, unknown>;
  const text = String(result.answer || result.description || result.response || result.result || '');
  return normalizeOcr(parseJsonObject(text));
}
