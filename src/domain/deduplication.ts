import type { ReceiptFields } from './receipt';

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase().replace(/\s+/g, ' ');
}

export function buildTicketFingerprint(fields: ReceiptFields): string {
  return [
    normalize(fields.storeId || fields.storeName),
    normalize(fields.ticketNumber),
    fields.purchaseDate,
    String(fields.totalCents),
    normalize(fields.currency),
  ].join('|');
}
