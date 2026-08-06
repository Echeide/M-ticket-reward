import type { OcrReceipt } from './receipt';

export type TrainingSampleInput = {
  ticketNumber: string;
  purchaseDate: string;
  totalCents: number;
  currency: string;
  notes: string;
};

export type TrainingEvaluationMatches = {
  store: boolean;
  ticketNumber: boolean;
  purchaseDate: boolean;
  total: boolean;
  evidence: boolean;
};

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
  const totalCents = Number(value.totalCents);
  const currency = String(value.currency || 'EUR').trim().toUpperCase();
  const notes = String(value.notes || '').trim();

  if (ticketNumber.length < 3 || ticketNumber.length > 160 || compactIdentifier(ticketNumber).length < 3) {
    throw new Error('TRAINING_TICKET_NUMBER_INVALID');
  }
  if (!validIsoDate(purchaseDate)) throw new Error('TRAINING_DATE_INVALID');
  if (!Number.isInteger(totalCents) || totalCents <= 0 || totalCents > 100_000_000) {
    throw new Error('TRAINING_TOTAL_INVALID');
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('TRAINING_CURRENCY_INVALID');
  if (notes.length > 1_000) throw new Error('TRAINING_NOTES_TOO_LONG');
  return { ticketNumber, purchaseDate, totalCents, currency, notes };
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
    total: receipt.totalCents === expected.totalCents && (receipt.currency || 'EUR') === expected.currency,
    evidence: verificationIssues.length === 0,
  };
}

export function trainingEvaluationPassed(matches: TrainingEvaluationMatches): boolean {
  return Object.values(matches).every(Boolean);
}
