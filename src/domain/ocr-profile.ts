import type { OcrReceipt } from './receipt';

export type OcrProfileRegion = 'header' | 'body' | 'footer' | 'any';

export type StoreOcrProfile = {
  version: 1;
  enabled: boolean;
  headerSignatures: string[];
  ticketNumberLabels: string[];
  dateLabels: string[];
  totalLabels: string[];
  ignoredTotalLabels: string[];
  ticketNumberRegion: OcrProfileRegion;
  dateRegion: OcrProfileRegion;
  totalRegion: OcrProfileRegion;
  dateFormat: string;
  instructions: string;
  sampleCount: number;
};

export type OcrProfileTrainingResult = {
  receipt: OcrReceipt | null;
  matches?: Partial<Record<'store' | 'ticketNumber' | 'purchaseDate' | 'total' | 'evidence', boolean>>;
  notes?: string;
};

const REGIONS = new Set<OcrProfileRegion>(['header', 'body', 'footer', 'any']);

function cleanList(value: unknown, limit: number): string[] {
  const values = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  return Array.from(new Set(values
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter((item) => item.length >= 2)
    .map((item) => item.slice(0, 100))))
    .slice(0, limit);
}

function region(value: unknown, fallback: OcrProfileRegion): OcrProfileRegion {
  const candidate = String(value || '').trim().toLowerCase() as OcrProfileRegion;
  return REGIONS.has(candidate) ? candidate : fallback;
}

export function emptyStoreOcrProfile(): StoreOcrProfile {
  return {
    version: 1,
    enabled: false,
    headerSignatures: [],
    ticketNumberLabels: [],
    dateLabels: [],
    totalLabels: [],
    ignoredTotalLabels: ['Subtotal', 'Ahorro', 'Cambio', 'Efectivo entregado'],
    ticketNumberRegion: 'header',
    dateRegion: 'header',
    totalRegion: 'footer',
    dateFormat: '',
    instructions: '',
    sampleCount: 0,
  };
}

export function normalizeStoreOcrProfile(value: unknown): StoreOcrProfile {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const defaults = emptyStoreOcrProfile();
  return {
    version: 1,
    enabled: input.enabled === true,
    headerSignatures: cleanList(input.headerSignatures, 20),
    ticketNumberLabels: cleanList(input.ticketNumberLabels, 20),
    dateLabels: cleanList(input.dateLabels, 20),
    totalLabels: cleanList(input.totalLabels, 20),
    ignoredTotalLabels: cleanList(input.ignoredTotalLabels ?? defaults.ignoredTotalLabels, 30),
    ticketNumberRegion: region(input.ticketNumberRegion, 'header'),
    dateRegion: region(input.dateRegion, 'header'),
    totalRegion: region(input.totalRegion, 'footer'),
    dateFormat: String(input.dateFormat || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    instructions: String(input.instructions || '').trim().slice(0, 2_000),
    sampleCount: Math.max(0, Math.min(10_000, Number.parseInt(String(input.sampleCount || 0), 10) || 0)),
  };
}

function firstLabel(value: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match?.[1]) return match[1].replace(/\s+/g, ' ').trim();
  }
  return '';
}

function dateFormat(value: string): string {
  if (/\b\d{1,2}[/.]\d{1,2}[/.]\d{4}\b/.test(value)) return 'DD/MM/AAAA';
  if (/\b\d{1,2}[/.]\d{1,2}[/.]\d{2}\b/.test(value)) return 'DD/MM/AA';
  if (/\b\d{4}-\d{1,2}-\d{1,2}\b/.test(value)) return 'AAAA-MM-DD';
  return '';
}

export function generateStoreOcrProfile(
  store: { name: string; aliases?: string[] },
  results: OcrProfileTrainingResult[],
): StoreOcrProfile {
  const headerSignatures = cleanList([store.name, ...(store.aliases || [])], 20);
  const ticketNumberLabels: string[] = [];
  const dateLabels: string[] = [];
  const totalLabels: string[] = [];
  const formats: string[] = [];
  const notes: string[] = [];

  for (const result of results) {
    const receipt = result.receipt;
    if (result.notes) notes.push(result.notes);
    if (!receipt) continue;
    const headerLines = String(receipt.headerText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const identityLine = headerLines.find((line) =>
      /\b(?:[ABCDEFGHJNPQRSUVW]\d{7}[A-Z0-9]|\d{8}[A-Z])\b/i.test(line));
    if (identityLine) headerSignatures.push(identityLine);

    if (result.matches?.ticketNumber !== false) {
      const label = firstLabel(receipt.evidence?.ticketNumberText || '', [
        /\b((?:n(?:[º°o]|úm(?:ero)?)|documento|ticket|factura|recibo|transacci[oó]n|operaci[oó]n|folio)(?:\s+[^:#\n]{1,24})?)\s*[:#-]/i,
      ]);
      if (label) ticketNumberLabels.push(label);
    }
    if (result.matches?.purchaseDate !== false) {
      const evidence = receipt.evidence?.purchaseDateText || '';
      const label = firstLabel(evidence, [
        /\b((?:fecha|f\.)\s*(?:de\s+)?(?:operaci[oó]n|compra|emisi[oó]n)?)\s*[:#-]?\s*\d/i,
      ]);
      if (label) dateLabels.push(label);
      const format = dateFormat(evidence);
      if (format) formats.push(format);
    }
    if (result.matches?.total !== false) {
      const label = firstLabel(receipt.evidence?.totalText || '', [
        /\b((?:importe\s+)?total(?:\s+(?:a\s+pagar|compra|ticket))?)\s*[:#-]?\s*\d/i,
      ]);
      if (label) totalLabels.push(label);
    }
  }

  const uniqueFormats = cleanList(formats, 4);
  const profile = normalizeStoreOcrProfile({
    enabled: false,
    headerSignatures,
    ticketNumberLabels,
    dateLabels,
    totalLabels,
    ignoredTotalLabels: ['Subtotal', 'Ahorro', 'Cambio', 'Efectivo entregado', 'Total impuestos'],
    ticketNumberRegion: 'header',
    dateRegion: 'header',
    totalRegion: 'footer',
    dateFormat: uniqueFormats.length === 1 ? uniqueFormats[0] : '',
    instructions: cleanList(notes, 12).map((note) => `- ${note}`).join('\n'),
    sampleCount: results.length,
  });
  return profile;
}

export function profileHasGuidance(profile: StoreOcrProfile): boolean {
  return profile.enabled && Boolean(
    profile.headerSignatures.length || profile.ticketNumberLabels.length || profile.dateLabels.length ||
    profile.totalLabels.length || profile.instructions,
  );
}
