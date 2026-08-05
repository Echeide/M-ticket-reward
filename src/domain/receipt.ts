export const RECEIPT_STATUSES = [
  'OCR_QUEUED',
  'OCR_PROCESSING',
  'READY_FOR_CONFIRMATION',
  'NOT_A_RECEIPT',
  'DUPLICATE',
  'AUTO_REJECTED',
  'REWARD_PENDING',
  'REWARDED',
  'REWARD_FAILED',
  'REVOKE_PENDING',
  'REVOKED',
] as const;

export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export type ReceiptFields = {
  storeId: string;
  storeName: string;
  ticketNumber: string;
  purchaseDate: string;
  totalCents: number;
  currency: string;
};

export type OcrReceipt = Partial<ReceiptFields> & {
  isReceipt: boolean;
  confidence: number;
  rawText?: string;
};

export type AutomaticValidationInput = {
  fields: ReceiptFields;
  ocr: OcrReceipt;
  storeActive: boolean;
  duplicate: boolean;
  now?: Date;
  maximumDateDifferenceDays?: number;
};

export type AutomaticValidation = {
  approved: boolean;
  riskScore: number;
  reasons: string[];
};

export function validateReceiptAutomatically(
  input: AutomaticValidationInput,
): AutomaticValidation {
  const reasons: string[] = [];
  let riskScore = 0;
  const now = input.now ?? new Date();
  const maximumDateDifferenceDays = input.maximumDateDifferenceDays ?? 3;
  const purchaseDay = isoDateToEpochDay(input.fields.purchaseDate);
  const currentDay = currentEpochDay(now);

  if (!input.ocr.isReceipt) reasons.push('NOT_A_RECEIPT');
  if (input.duplicate) reasons.push('DUPLICATE');
  if (!input.storeActive) reasons.push('STORE_NOT_ALLOWED');
  if (!input.fields.ticketNumber.trim()) reasons.push('TICKET_NUMBER_REQUIRED');
  if (!Number.isInteger(input.fields.totalCents) || input.fields.totalCents <= 0) {
    reasons.push('INVALID_TOTAL');
  }
  if (purchaseDay === null) {
    reasons.push('INVALID_DATE');
  } else {
    const differenceDays = currentDay - purchaseDay;
    if (differenceDays < -maximumDateDifferenceDays) reasons.push('FUTURE_DATE');
    if (differenceDays > maximumDateDifferenceDays) reasons.push('TICKET_TOO_OLD');
  }

  if (input.ocr.confidence < 0.55) riskScore += 45;
  else if (input.ocr.confidence < 0.75) riskScore += 20;
  if (input.ocr.ticketNumber && input.ocr.ticketNumber !== input.fields.ticketNumber) {
    riskScore += 15;
  }
  if (input.ocr.totalCents && input.ocr.totalCents !== input.fields.totalCents) {
    riskScore += 20;
  }
  if (input.ocr.purchaseDate && input.ocr.purchaseDate !== input.fields.purchaseDate) {
    riskScore += 10;
  }

  return {
    approved: reasons.length === 0,
    riskScore: Math.min(100, riskScore),
    reasons,
  };
}

function isoDateToEpochDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return Math.floor(timestamp / 86_400_000);
}

function currentEpochDay(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Atlantic/Canary',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value);
  return Math.floor(Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000);
}
