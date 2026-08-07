import type { OcrReceipt } from './receipt';

export type OcrProfileRegion = 'header' | 'body' | 'footer' | 'any';

export type StoreOcrProfile = {
  version: 1;
  enabled: boolean;
  headerSignatures: string[];
  ticketNumberLabels: string[];
  ticketNumberHelp: string;
  ticketNumberExample: string;
  ticketNumberPattern: string;
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
  matches?: Partial<Record<'store' | 'ticketNumber' | 'purchaseDate' | 'purchaseTime' | 'total' | 'evidence', boolean>>;
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

function cleanTicketNumberLabel(value: string): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  const core = /^(?:(?:n(?:[º°o]|úm(?:ero)?)\.?)(?:\s+(?:de|del)\s+(?:documento|ticket|factura|recibo|venta|operaci[oó]n))?|documento|ticket|factura|recibo|transacci[oó]n|operaci[oó]n|folio)(?=\s|[.:#-]|$)/i.exec(normalized);
  return core?.[0]?.trim() || normalized;
}

function ticketNumberProfileFields(value: Record<string, unknown>): {
  labels: string[];
  help: string;
} {
  const rawLabels = cleanList(value.ticketNumberLabels, 20);
  const labels = Array.from(new Set(rawLabels.map(cleanTicketNumberLabel))).slice(0, 20);
  let help = String(value.ticketNumberHelp || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  rawLabels.forEach((rawLabel, index) => {
    const label = labels[index] || cleanTicketNumberLabel(rawLabel);
    if (label !== rawLabel) help = help.replaceAll(rawLabel, label);
  });
  return { labels, help };
}

export function ticketNumberPatternFromExample(value: string): string {
  const source = String(value || '').normalize('NFKC').trim().toUpperCase().slice(0, 100);
  let pattern = '';
  for (let index = 0; index < source.length;) {
    const digits = /^\d+/.exec(source.slice(index))?.[0];
    if (digits) {
      pattern += index === 0 && digits.length === 4 && /^20\d{2}$/.test(digits)
        ? 'AAAA'
        : 'N'.repeat(digits.length);
      index += digits.length;
      continue;
    }
    pattern += source[index]!;
    index += 1;
  }
  return pattern;
}

function mergeTicketNumberPatterns(patterns: string[]): string {
  const unique = Array.from(new Set(patterns.filter(Boolean))).sort((left, right) => left.length - right.length);
  if (!unique.length) return '';
  const shortest = unique[0]!;
  if (unique.length === 1) return shortest;
  if (unique.every((pattern) => pattern.startsWith(shortest) && /^N*$/.test(pattern.slice(shortest.length)))) {
    const optionalDigits = unique.at(-1)!.length - shortest.length;
    return `${shortest}${'[N]'.repeat(optionalDigits)}`;
  }
  return '';
}

function cleanTicketNumberPattern(value: unknown, example: string): string {
  const candidate = String(value || ticketNumberPatternFromExample(example))
    .normalize('NFKC').replace(/\s+/g, '').toUpperCase().slice(0, 160);
  if (!candidate || !candidate.includes('N')) return '';
  if (!/^[A-Z0-9./\[\]-]+$/.test(candidate)) return '';
  if (candidate.replaceAll('[N]', '').includes('[') || candidate.replaceAll('[N]', '').includes(']')) return '';
  return candidate;
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
    ticketNumberHelp: '',
    ticketNumberExample: '',
    ticketNumberPattern: '',
    dateLabels: [],
    totalLabels: [],
    ignoredTotalLabels: ['Subtotal', 'Ahorro', 'Cambio', 'Efectivo entregado'],
    ticketNumberRegion: 'header',
    dateRegion: 'header',
    totalRegion: 'footer',
    dateFormat: 'DD/MM/AAAA',
    instructions: '',
    sampleCount: 0,
  };
}

export function normalizeStoreOcrProfile(value: unknown): StoreOcrProfile {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const defaults = emptyStoreOcrProfile();
  const ticketNumber = ticketNumberProfileFields(input);
  const ticketNumberExample = String(input.ticketNumberExample || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return {
    version: 1,
    enabled: input.enabled === true,
    headerSignatures: cleanList(input.headerSignatures, 20),
    ticketNumberLabels: ticketNumber.labels,
    ticketNumberHelp: ticketNumber.help,
    ticketNumberExample,
    ticketNumberPattern: cleanTicketNumberPattern(input.ticketNumberPattern, ticketNumberExample),
    dateLabels: cleanList(input.dateLabels, 20),
    totalLabels: cleanList(input.totalLabels, 20),
    ignoredTotalLabels: cleanList(input.ignoredTotalLabels ?? defaults.ignoredTotalLabels, 30),
    ticketNumberRegion: region(input.ticketNumberRegion, 'header'),
    dateRegion: region(input.dateRegion, 'header'),
    totalRegion: region(input.totalRegion, 'footer'),
    dateFormat: String(input.dateFormat || defaults.dateFormat).replace(/\s+/g, ' ').trim().slice(0, 40),
    instructions: String(input.instructions || '').trim().slice(0, 2_000),
    sampleCount: Math.max(0, Math.min(10_000, Number.parseInt(String(input.sampleCount || 0), 10) || 0)),
  };
}

function syntheticTicketNumberExample(value: string): string {
  const source = String(value || '').trim().slice(0, 160);
  let groupIndex = 0;
  const example = source.replace(/\d+/g, (digits) => {
    groupIndex += 1;
    if (groupIndex === 1 && /^20\d{2}$/.test(digits)) return digits;
    const leadingZeroCount = Math.min(digits.match(/^0+/)?.[0].length || 0, digits.length - 1);
    const replacementLength = digits.length - leadingZeroCount;
    const replacement = '1234567890'.repeat(Math.ceil(replacementLength / 10)).slice(0, replacementLength);
    return `${'0'.repeat(leadingZeroCount)}${replacement}`;
  });
  if (!/\d/.test(source)) return '';
  if (example !== source) return example;
  return source.replace(/\d+/g, (digits) => {
    const replacement = '9876543210'.repeat(Math.ceil(digits.length / 10));
    return replacement.slice(0, digits.length);
  });
}

function ticketNumberHelp(label: string, region: OcrProfileRegion): string {
  if (!label) return '';
  const locations: Record<OcrProfileRegion, string> = {
    header: 'en la cabecera del ticket',
    body: 'en la zona central del ticket',
    footer: 'al final del ticket',
    any: 'en el ticket',
  };
  return `Busca el número identificado como «${label}» ${locations[region]}.`;
}

function normalizedEvidencePart(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function ticketNumberIsBelowLabel(evidence: string, label: string, ticketNumber: string): boolean {
  const lines = evidence.split(/\r?\n/).map((line) => normalizedEvidencePart(line)).filter(Boolean);
  const normalizedLabel = normalizedEvidencePart(label);
  const normalizedTicketNumber = normalizedEvidencePart(ticketNumber);
  return lines.some((line, index) => line.includes(normalizedLabel)
    && Boolean(lines[index + 1]?.includes(normalizedTicketNumber)));
}

function firstLabel(value: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match?.[1]) return match[1].replace(/\s+/g, ' ').trim();
  }
  return '';
}

function dateFormat(value: string): string {
  if (/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b/.test(value)) return 'DD/MM/AAAA';
  if (/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2}\b/.test(value)) return 'DD/MM/AA';
  if (/\b\d{4}-\d{1,2}-\d{1,2}\b/.test(value)) return 'AAAA-MM-DD';
  if (/\b\d{1,2}\s+(?:de\s+)?(?:ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)/i.test(value)) {
    return 'D MMM AAAA';
  }
  return '';
}

export function generateStoreOcrProfile(
  store: { name: string; aliases?: string[] },
  results: OcrProfileTrainingResult[],
): StoreOcrProfile {
  const headerSignatures = cleanList([store.name, ...(store.aliases || [])], 20);
  const ticketNumberLabels: string[] = [];
  const ticketNumberHelpCandidates: string[] = [];
  const ticketNumberExamples: string[] = [];
  const ticketNumberPatterns: string[] = [];
  const dateLabels: string[] = [];
  const totalLabels: string[] = [];
  const formats: string[] = [];
  const notes: string[] = [];
  let sampleCount = 0;

  for (const result of results) {
    const receipt = result.receipt;
    if (!receipt || result.matches?.store !== true) continue;
    sampleCount += 1;
    if (result.notes) notes.push(result.notes);
    const headerLines = String(receipt.headerText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const identityLine = headerLines.find((line) =>
      /\b(?:[ABCDEFGHJNPQRSUVW]\d{7}[A-Z0-9]|\d{8}[A-Z])\b/i.test(line));
    if (identityLine) headerSignatures.push(identityLine);

    if (result.matches?.ticketNumber === true) {
      const ticketNumberEvidence = receipt.evidence?.ticketNumberText || '';
      const label = firstLabel(ticketNumberEvidence, [
        /\b((?:n(?:[º°o]|úm(?:ero)?)|documento|ticket|factura|recibo|transacci[oó]n|operaci[oó]n|folio)(?:[ \t]+[^:#\n]{1,24})?)[ \t]*(?::|#|-|\r?\n)[ \t]*(?=[A-Z0-9])/i,
      ]);
      if (label) {
        const cleanedLabel = cleanTicketNumberLabel(label);
        ticketNumberLabels.push(cleanedLabel);
        ticketNumberHelpCandidates.push(ticketNumberIsBelowLabel(
          ticketNumberEvidence, cleanedLabel, receipt.ticketNumber || '',
        ) ? `Busca el número debajo de «${cleanedLabel}».` : ticketNumberHelp(cleanedLabel, 'header'));
      }
      if (receipt.ticketNumber) {
        ticketNumberExamples.push(syntheticTicketNumberExample(receipt.ticketNumber));
        ticketNumberPatterns.push(ticketNumberPatternFromExample(receipt.ticketNumber));
      }
    }
    if (result.matches?.purchaseDate === true) {
      const evidence = receipt.evidence?.purchaseDateText || '';
      const dateLabel = firstLabel(evidence, [
        /\b((?:fecha|f\.)\s*(?:de\s+)?(?:operaci[oó]n|compra|emisi[oó]n)?)\s*[:#-]?\s*\d/i,
      ]);
      const timeLabel = firstLabel(evidence, [
        /\b((?:hora|h\.))\s*[:#-]?\s*\d/i,
      ]);
      if (dateLabel) dateLabels.push(dateLabel);
      if (timeLabel) dateLabels.push(timeLabel);
      const format = dateFormat(evidence);
      if (format) formats.push(format);
    }
    if (result.matches?.total === true) {
      const label = firstLabel(receipt.evidence?.totalText || '', [
        /\b((?:importe\s+)?total(?:\s+(?:a\s+pagar|compra|ticket))?)\s*[:#-]?\s*\d/i,
      ]);
      if (label) totalLabels.push(label);
    }
  }

  const formatCounts = formats.reduce((counts, format) => {
    counts.set(format, (counts.get(format) || 0) + 1);
    return counts;
  }, new Map<string, number>());
  const preferredFormats = ['DD/MM/AAAA', 'DD/MM/AA', 'D MMM AAAA', 'AAAA-MM-DD'];
  const learnedDateFormat = [...formatCounts.entries()]
    .sort((left, right) => right[1] - left[1]
      || preferredFormats.indexOf(left[0]) - preferredFormats.indexOf(right[0]))[0]?.[0]
    || 'DD/MM/AAAA';
  const normalizedTicketNumberLabels = cleanList(ticketNumberLabels, 20);
  const profile = normalizeStoreOcrProfile({
    enabled: false,
    headerSignatures,
    ticketNumberLabels: normalizedTicketNumberLabels,
    ticketNumberHelp: ticketNumberHelpCandidates[0]
      || ticketNumberHelp(normalizedTicketNumberLabels[0] || '', 'header'),
    ticketNumberExample: ticketNumberExamples[0] || '',
    ticketNumberPattern: mergeTicketNumberPatterns(ticketNumberPatterns),
    dateLabels,
    totalLabels,
    ignoredTotalLabels: ['Subtotal', 'Ahorro', 'Cambio', 'Efectivo entregado', 'Total impuestos'],
    ticketNumberRegion: 'header',
    dateRegion: 'header',
    totalRegion: 'footer',
    dateFormat: learnedDateFormat,
    instructions: cleanList(notes, 12).map((note) => `- ${note}`).join('\n'),
    sampleCount,
  });
  return profile;
}

export function profileHasGuidance(profile: StoreOcrProfile): boolean {
  return profile.enabled && Boolean(
    profile.headerSignatures.length || profile.ticketNumberLabels.length || profile.ticketNumberPattern || profile.dateLabels.length ||
    profile.totalLabels.length || profile.instructions,
  );
}
