import type { ReceiptFields } from './receipt';

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase().replace(/\s+/g, ' ');
}

export function buildTicketFingerprint(fields: ReceiptFields): string {
  const printedIdentity = normalize(fields.ticketNumber) || `@TIME:${String(fields.purchaseDateTime || '')}`;
  return [
    normalize(fields.storeId || fields.storeName),
    printedIdentity,
    fields.purchaseDate,
    String(fields.totalCents),
    normalize(fields.currency),
  ].join('|');
}

export function buildTicketIdentityKey(storeId: string, ticketNumber: string): string | null {
  const store = normalize(storeId).replace(/[^A-Z0-9]/g, '');
  const number = normalize(ticketNumber).replace(/[^A-Z0-9]/g, '');
  if (!store || number.length < 3) return null;
  return `${store}|${number}`;
}
