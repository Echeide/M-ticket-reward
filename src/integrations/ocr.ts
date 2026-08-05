import type { OcrReceipt } from '../domain/receipt';
import type { StoreIdentity } from '../domain/store';
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
  const rawCurrency = String(value.currency || 'EUR').trim().toUpperCase();
  const currency = ['€', 'EURO', 'EUROS'].includes(rawCurrency) || !/^[A-Z]{3}$/.test(rawCurrency)
    ? 'EUR'
    : rawCurrency;
  return {
    isReceipt: value.isReceipt === true,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    storeName: String(value.storeName || '').trim(),
    headerText: String(value.headerText || '').trim().slice(0, 2_000),
    ticketNumber: String(value.ticketNumber || '').trim(),
    purchaseDate: String(value.purchaseDate || '').trim(),
    totalCents: Number.isInteger(total) ? total : undefined,
    currency,
    rawText: String(value.rawText || '').slice(0, 8_000),
  };
}

function authorizedStoreReference(stores: StoreIdentity[]): string {
  const entries: string[] = [];
  let length = 2;
  for (const store of stores.slice(0, 80)) {
    const entry = JSON.stringify({
      name: store.name,
      aliases: (Array.isArray(store.aliases) ? store.aliases : []).slice(0, 12),
    });
    if (length + entry.length + entries.length > 6_000) break;
    entries.push(entry);
    length += entry.length;
  }
  return `[${entries.join(',')}]`;
}

export async function readReceipt(
  env: Env,
  bytes: ArrayBuffer,
  _contentType = 'image/jpeg',
  authorizedStores: StoreIdentity[] = [],
): Promise<OcrReceipt> {
  if (env.OCR_MODE === 'mock') {
    return {
      isReceipt: true,
      confidence: 0.93,
      storeName: 'Tienda asociada',
      headerText: 'Tienda asociada',
      ticketNumber: `DEMO-${Date.now().toString(36).toUpperCase()}`,
      purchaseDate: new Date().toISOString().slice(0, 10),
      totalCents: 7500,
      currency: 'EUR',
      rawText: 'Resultado OCR simulado para desarrollo local',
    };
  }

  const storeReference = authorizedStoreReference(authorizedStores);
  const prompt = `Analiza la imagen como un ticket de compra y devuelve exclusivamente un objeto JSON con:
isReceipt (boolean), confidence (0..1), storeName, headerText, ticketNumber,
purchaseDate (YYYY-MM-DD), totalCents (entero), currency y rawText.

Reglas obligatorias para storeName:
- Es el comercio emisor del ticket, nunca un producto, artículo, marca del listado de compra,
  eslogan, método de pago ni nombre del cliente.
- Búscalo solo en la cabecera o bloque fiscal: logotipo, razón social, CIF/NIF, dirección,
  teléfono o texto anterior al primer artículo.
- headerText debe transcribir únicamente esa cabecera o bloque fiscal.
- Estos son los comercios autorizados y sus alias: ${storeReference}.
- Usa esa lista solo como referencia. Si la cabecera coincide claramente con un nombre o alias,
  devuelve exactamente el campo name correspondiente. Si no hay evidencia visible, deja storeName vacío.

Usa exclusivamente la fecha impresa; no uses la fecha actual si no es legible.
No inventes valores ilegibles y expresa los importes en céntimos.`;
  const result = (await (env.AI as unknown as { run: Function }).run(env.OCR_MODEL, {
    image: Array.from(new Uint8Array(bytes)),
    prompt,
    temperature: 0.1,
    max_tokens: 1_024,
  })) as Record<string, unknown>;
  const text = String(result.answer || result.description || result.response || result.result || '');
  return normalizeOcr(parseJsonObject(text));
}
