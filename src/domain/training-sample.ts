import { isValidPurchaseDateTime, type OcrReceipt } from './receipt';
import type { StoreOcrProfile } from './ocr-profile';
import type { StoreIdentity } from './store';

export type TrainingSampleInput = {
  ticketNumber: string;
  purchaseDate: string;
  purchaseDateTime: string;
  totalCents: number;
  currency: string;
  notes: string;
};

export type TrainingEvaluationMatches = {
  store: boolean;
  ticketNumber: boolean;
  purchaseDate: boolean;
  purchaseTime: boolean;
  total: boolean;
  evidence: boolean;
};

export type TrainingEvaluationContext = {
  catalogStoreCount: number;
  targetStoreActive: boolean;
  targetIncludedOutsideProduction: boolean;
  profileMode: 'PRODUCTION' | 'CANDIDATE';
};

export function buildTrainingOcrCatalog<T extends StoreIdentity & { id: string; active: boolean }>(
  stores: T[],
  targetStoreId: string,
  candidateProfile: StoreOcrProfile | null,
): { stores: T[]; context: TrainingEvaluationContext } {
  const targetStore = stores.find((store) => store.id === targetStoreId);
  if (!targetStore) throw new Error('TRAINING_STORE_NOT_FOUND');
  const activeStores = stores.filter((store) => store.active);
  const targetIncludedOutsideProduction = !targetStore.active;
  const evaluationStores = targetIncludedOutsideProduction
    ? [...activeStores, targetStore]
    : activeStores;
  return {
    stores: evaluationStores.map((store) => store.id === targetStoreId && candidateProfile
      ? { ...store, ocrProfile: candidateProfile }
      : store),
    context: {
      catalogStoreCount: activeStores.length,
      targetStoreActive: targetStore.active,
      targetIncludedOutsideProduction,
      profileMode: candidateProfile ? 'CANDIDATE' : 'PRODUCTION',
    },
  };
}

function compactIdentifier(value: string): string {
  return value.normalize('NFKD').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

export function normalizeTrainingSampleInput(value: Record<string, unknown>): TrainingSampleInput {
  const ticketNumber = String(value.ticketNumber || '').trim();
  const purchaseDate = String(value.purchaseDate || '').trim();
  const purchaseDateTime = String(value.purchaseDateTime || '').trim();
  const totalCents = Number(value.totalCents);
  const currency = String(value.currency || 'EUR').trim().toUpperCase();
  const notes = String(value.notes || '').trim();

  if (ticketNumber && (ticketNumber.length < 3 || ticketNumber.length > 160 || compactIdentifier(ticketNumber).length < 3)) {
    throw new Error('TRAINING_TICKET_NUMBER_INVALID');
  }
  if (!validIsoDate(purchaseDate)) throw new Error('TRAINING_DATE_INVALID');
  if (purchaseDateTime && !isValidPurchaseDateTime(purchaseDateTime, purchaseDate)) {
    throw new Error('TRAINING_PURCHASE_TIME_INVALID');
  }
  if (!ticketNumber && !purchaseDateTime) throw new Error('TRAINING_IDENTITY_REQUIRED');
  if (!Number.isInteger(totalCents) || totalCents <= 0 || totalCents > 100_000_000) {
    throw new Error('TRAINING_TOTAL_INVALID');
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('TRAINING_CURRENCY_INVALID');
  if (notes.length > 1_000) throw new Error('TRAINING_NOTES_TOO_LONG');
  return { ticketNumber, purchaseDate, purchaseDateTime, totalCents, currency, notes };
}

export function compareTrainingResult(
  expected: TrainingSampleInput,
  receipt: OcrReceipt,
  storeMatched: boolean,
  verificationIssues: string[],
): TrainingEvaluationMatches {
  return {
    store: storeMatched,
    ticketNumber: compactIdentifier(receipt.ticketNumber || '') === compactIdentifier(expected.ticketNumber),
    purchaseDate: receipt.purchaseDate === expected.purchaseDate,
    purchaseTime: !expected.purchaseDateTime || receipt.purchaseDateTime === expected.purchaseDateTime,
    total: receipt.totalCents === expected.totalCents && (receipt.currency || 'EUR') === expected.currency,
    evidence: verificationIssues.length === 0,
  };
}

export function trainingEvaluationPassed(matches: TrainingEvaluationMatches): boolean {
  return Object.values(matches).every(Boolean);
}
