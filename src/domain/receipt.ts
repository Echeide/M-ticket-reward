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
  purchaseDateTime?: string;
  totalCents: number;
  currency: string;
};

export type OcrReceipt = Partial<ReceiptFields> & {
  isReceipt: boolean;
  confidence: number;
  headerText?: string;
  rawText?: string;
  evidence?: {
    ticketNumberText?: string;
    purchaseDateText?: string;
    totalText?: string;
  };
};

export type AutomaticValidationInput = {
  fields: ReceiptFields;
  ocr: OcrReceipt;
  storeActive: boolean;
  duplicate: boolean;
  now?: Date;
  maximumDateDifferenceDays?: number;
  allowedPurchaseStart?: string;
  allowedPurchaseEnd?: string;
};

export type AutomaticValidation = {
  approved: boolean;
  riskScore: number;
  reasons: string[];
};

export function receiptStatusAfterOcr(validation: AutomaticValidation): ReceiptStatus {
  if (validation.reasons.includes('NOT_A_RECEIPT')) return 'NOT_A_RECEIPT';
  if (validation.reasons.includes('DUPLICATE')) return 'DUPLICATE';
  return validation.approved ? 'REWARD_PENDING' : 'AUTO_REJECTED';
}

export function canReprocessReceipt(status: string, reasons: string[] = []): boolean {
  if (['AUTO_REJECTED', 'NOT_A_RECEIPT', 'READY_FOR_CONFIRMATION'].includes(status)) return true;
  return status === 'REWARD_FAILED' && reasons.some((reason) =>
    ['OCR_PROCESSING_FAILED', 'OCR_VERIFICATION_REQUIRED'].includes(reason));
}

export function validateReceiptAutomatically(
  input: AutomaticValidationInput,
): AutomaticValidation {
  const reasons: string[] = [];
  let riskScore = 0;
  const now = input.now ?? new Date();
  const maximumDateDifferenceDays = input.maximumDateDifferenceDays ?? 3;
  const purchaseDay = isoDateToEpochDay(input.fields.purchaseDate);
  const currentDay = currentEpochDay(now);
  const allowedStart = canaryDateTimeToTimestamp(input.allowedPurchaseStart || '');
  const allowedEnd = canaryDateTimeToTimestamp(input.allowedPurchaseEnd || '');
  const hasConfiguredPeriod = allowedStart !== null || allowedEnd !== null;

  if (!input.ocr.isReceipt) reasons.push('NOT_A_RECEIPT');
  if (input.duplicate) reasons.push('DUPLICATE');
  if (!input.storeActive) reasons.push('STORE_NOT_ALLOWED');
  if (!input.fields.ticketNumber.trim() && !hasVerifiedPurchaseTime(input.ocr, input.fields.purchaseDate)) {
    reasons.push('TICKET_NUMBER_OR_TIME_REQUIRED');
  }
  if (!Number.isInteger(input.fields.totalCents) || input.fields.totalCents <= 0) {
    reasons.push('INVALID_TOTAL');
  }
  if (purchaseDay === null) {
    reasons.push('INVALID_DATE');
  } else if (hasConfiguredPeriod) {
    const recognizedDateTime = String(input.ocr.purchaseDateTime || '');
    const purchaseTimestamp = recognizedDateTime.startsWith(`${input.fields.purchaseDate}T`)
      ? canaryDateTimeToTimestamp(recognizedDateTime)
      : null;
    if (purchaseTimestamp !== null) {
      if (allowedStart !== null && purchaseTimestamp < allowedStart) reasons.push('TICKET_TOO_OLD');
      if (allowedEnd !== null && purchaseTimestamp > allowedEnd) reasons.push('FUTURE_DATE');
    } else {
      const startDay = isoDateToEpochDay((input.allowedPurchaseStart || '').slice(0, 10));
      const endDay = isoDateToEpochDay((input.allowedPurchaseEnd || '').slice(0, 10));
      if (startDay !== null && purchaseDay < startDay) reasons.push('TICKET_TOO_OLD');
      if (endDay !== null && purchaseDay > endDay) reasons.push('FUTURE_DATE');
    }
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

export function isValidPurchaseDateTime(value: string, purchaseDate: string): boolean {
  if (!value.startsWith(`${purchaseDate}T`)) return false;
  return canaryDateTimeToTimestamp(value) !== null;
}

export function hasVerifiedPurchaseTime(ocr: OcrReceipt, purchaseDate = ocr.purchaseDate || ''): boolean {
  const purchaseDateTime = String(ocr.purchaseDateTime || '');
  if (!isValidPurchaseDateTime(purchaseDateTime, purchaseDate)) return false;
  const printedTime = /(?:^|\D)([01]\d|2[0-3]):([0-5]\d)(?:\D|$)/.exec(
    String(ocr.evidence?.purchaseDateText || ''),
  );
  return Boolean(printedTime && `${printedTime[1]}:${printedTime[2]}` === purchaseDateTime.slice(11, 16));
}

function canaryDateTimeToTimestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const expected = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]),
  };
  const wallTimestamp = Date.UTC(
    expected.year, expected.month - 1, expected.day, expected.hour, expected.minute,
  );
  const wallDate = new Date(wallTimestamp);
  if (
    wallDate.getUTCFullYear() !== expected.year ||
    wallDate.getUTCMonth() !== expected.month - 1 ||
    wallDate.getUTCDate() !== expected.day ||
    wallDate.getUTCHours() !== expected.hour ||
    wallDate.getUTCMinutes() !== expected.minute
  ) return null;

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Atlantic/Canary', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const wallPartsAt = (timestamp: number) => {
    const parts = formatter.formatToParts(new Date(timestamp));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((item) => item.type === type)?.value);
    return {
      year: part('year'), month: part('month'), day: part('day'),
      hour: part('hour'), minute: part('minute'),
    };
  };
  const timestampForParts = (parts: ReturnType<typeof wallPartsAt>) =>
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let result = wallTimestamp - (timestampForParts(wallPartsAt(wallTimestamp)) - wallTimestamp);
  result = wallTimestamp - (timestampForParts(wallPartsAt(result)) - result);
  const resolved = wallPartsAt(result);
  return Object.entries(expected).every(([key, value]) => resolved[key as keyof typeof resolved] === value)
    ? result
    : null;
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

export function isValidIsoDate(value: string): boolean {
  return isoDateToEpochDay(value) !== null;
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
