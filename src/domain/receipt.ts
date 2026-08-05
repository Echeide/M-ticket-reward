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
  maximumAgeDays?: number;
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
  const maximumAgeDays = input.maximumAgeDays ?? 90;
  const purchaseDate = new Date(`${input.fields.purchaseDate}T12:00:00Z`);

  if (!input.ocr.isReceipt) reasons.push('NOT_A_RECEIPT');
  if (input.duplicate) reasons.push('DUPLICATE');
  if (!input.storeActive) reasons.push('STORE_NOT_ALLOWED');
  if (!input.fields.ticketNumber.trim()) reasons.push('TICKET_NUMBER_REQUIRED');
  if (!Number.isInteger(input.fields.totalCents) || input.fields.totalCents <= 0) {
    reasons.push('INVALID_TOTAL');
  }
  if (Number.isNaN(purchaseDate.getTime())) {
    reasons.push('INVALID_DATE');
  } else {
    const ageDays = (now.getTime() - purchaseDate.getTime()) / 86_400_000;
    if (ageDays < -1) reasons.push('FUTURE_DATE');
    if (ageDays > maximumAgeDays) reasons.push('TICKET_TOO_OLD');
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
