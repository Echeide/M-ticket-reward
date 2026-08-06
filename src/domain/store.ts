import type { StoreOcrProfile } from './ocr-profile';

export type StoreInput = {
  code: string;
  name: string;
  aliases: string[];
  active: boolean;
};

export type StoreIdentity = {
  name: string;
  aliases: string[];
  ocrProfile?: StoreOcrProfile;
};

export type StoreOcrEvidence = {
  storeName?: string;
  headerText?: string;
  rawText?: string;
};

function normalizeStoreText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/&/g, ' y ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function withoutLegalSuffix(value: string): string {
  return value
    .replace(/\b(?:s l u|s l|s a|s c|sociedad limitada|sociedad anonima|sociedad cooperativa)\b$/g, '')
    .trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  return phrase.length >= 3 && ` ${text} `.includes(` ${phrase} `);
}

function evidenceScore(
  candidate: string,
  evidence: string,
  exactScore: number,
  allowContained: boolean,
): number {
  if (!candidate || !evidence) return 0;
  if (candidate === evidence) return exactScore;
  const candidateWithoutLegalSuffix = withoutLegalSuffix(candidate);
  const evidenceWithoutLegalSuffix = withoutLegalSuffix(evidence);
  if (candidateWithoutLegalSuffix && candidateWithoutLegalSuffix === evidenceWithoutLegalSuffix) {
    return exactScore - 2;
  }
  if (allowContained && containsPhrase(evidence, candidate)) return exactScore - 10;
  if (
    allowContained && candidateWithoutLegalSuffix !== candidate &&
    containsPhrase(evidenceWithoutLegalSuffix, candidateWithoutLegalSuffix)
  ) return exactScore - 12;
  return 0;
}

export function findMatchingStore<T extends StoreIdentity>(
  stores: T[],
  evidence: StoreOcrEvidence,
): T | null {
  const merchantName = normalizeStoreText(evidence.storeName || '');
  const headerText = normalizeStoreText(evidence.headerText || '');
  // The merchant identity should be near the beginning. Searching the complete
  // item list could mistake a product or brand for the establishment.
  const rawHeader = normalizeStoreText((evidence.rawText || '').slice(0, 1_000));
  const matches = stores.map((store) => {
    const variants = [store.name, ...(Array.isArray(store.aliases) ? store.aliases : [])]
      .map(normalizeStoreText)
      .filter(Boolean);
    const score = variants.reduce((best, candidate) => Math.max(
      best,
      evidenceScore(candidate, merchantName, 100, false),
      evidenceScore(candidate, headerText, 85, true),
      evidenceScore(candidate, rawHeader, 65, true),
    ), 0);
    return { store, score };
  }).filter((match) => match.score > 0).sort((left, right) => right.score - left.score);

  if (!matches.length || matches[0]!.score === matches[1]?.score) return null;
  return matches[0]!.store;
}

export function normalizeStoreInput(value: Record<string, unknown>): StoreInput {
  const code = String(value.code || '').trim().toUpperCase();
  const name = String(value.name || '').trim();
  const rawAliases = Array.isArray(value.aliases)
    ? value.aliases
    : String(value.aliases || '').split(/[\n,]/);
  const aliases = Array.from(new Set(rawAliases
    .map((alias) => String(alias).trim())
    .filter(Boolean)))
    .slice(0, 30);

  if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code)) {
    throw new Error('STORE_CODE_INVALID');
  }
  if (name.length < 2 || name.length > 160) {
    throw new Error('STORE_NAME_INVALID');
  }
  if (aliases.some((alias) => alias.length > 160)) {
    throw new Error('STORE_ALIAS_INVALID');
  }

  return { code, name, aliases, active: value.active !== false };
}
