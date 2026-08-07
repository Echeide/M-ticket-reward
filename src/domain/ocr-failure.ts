export type OcrFailure = {
  error: string;
  reason: string;
  retryable: boolean;
};

function errorPart(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function ocrErrorMessage(caught: unknown): string {
  const parts: string[] = [];
  if (caught instanceof Error) {
    parts.push(caught.name, caught.message);
    const cause = caught.cause;
    if (cause instanceof Error) parts.push(cause.name, cause.message);
    else if (cause && typeof cause === 'object') {
      const record = cause as Record<string, unknown>;
      parts.push(errorPart(record.code), errorPart(record.status), errorPart(record.message));
    }
  } else if (caught && typeof caught === 'object') {
    const record = caught as Record<string, unknown>;
    parts.push(
      errorPart(record.name),
      errorPart(record.code),
      errorPart(record.status),
      errorPart(record.message),
    );
  } else {
    parts.push(errorPart(caught));
  }
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(': ')
    .replace(/\s+/g, ' ')
    .slice(0, 1_000) || 'UNKNOWN_OCR_ERROR';
}

export function classifyOcrFailure(caught: unknown): OcrFailure {
  const error = ocrErrorMessage(caught);
  const normalized = error.toUpperCase();

  if (/OCR_INVALID_JSON|EXPECTED PROPERTY NAME|JSON.*(?:POSITION|COLUMN)|UNTERMINATED STRING/.test(normalized)) {
    return { error, reason: 'OCR_INVALID_JSON', retryable: true };
  }
  if (/\b3036\b|DAILY FREE ALLOCATION|QUOTA|USAGE LIMIT/.test(normalized)) {
    return { error, reason: 'OCR_PROVIDER_QUOTA_EXCEEDED', retryable: false };
  }
  if (/\b5016\b|MODEL AGREEMENT|LICENSE|LICENCE/.test(normalized)) {
    return { error, reason: 'OCR_PROVIDER_LICENSE_REQUIRED', retryable: false };
  }
  if (/OCR_PROVIDER_CONFIGURATION_ERROR|\b(?:5004|5007|3003|3006|3042)\b|INVALID (?:DATA|MODEL)|REQUEST TOO LARGE|INCOMPLETE REQUEST|UNSUPPORTED/.test(normalized)) {
    return { error, reason: 'OCR_PROVIDER_CONFIGURATION_ERROR', retryable: false };
  }
  if (/\b3040\b|OUT OF CAPACITY|NO MORE DATA CENTERS|CAPACITY/.test(normalized)) {
    return { error, reason: 'OCR_PROVIDER_CAPACITY', retryable: true };
  }
  if (/\b429\b|RATE.?LIMIT|TOO MANY REQUESTS/.test(normalized)) {
    return { error, reason: 'OCR_PROVIDER_RATE_LIMITED', retryable: true };
  }
  if (/\b(?:3007|3008|408)\b|TIMEOUT|TIMED OUT|ABORT/.test(normalized)) {
    return { error, reason: 'OCR_PROVIDER_TIMEOUT', retryable: true };
  }
  if (/\b5\d\d\b|NETWORK|FETCH FAILED|CONNECTION|TEMPORAR(?:Y|ILY)|SERVICE UNAVAILABLE/.test(normalized)) {
    return { error, reason: 'OCR_PROVIDER_UNAVAILABLE', retryable: true };
  }
  return { error, reason: 'OCR_PROCESSING_FAILED', retryable: true };
}

export function ocrMaxAttempts(configured?: string): number {
  const value = Number(configured);
  return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.trunc(value))) : 3;
}

export function ocrRetryDelaySeconds(attempt: number): number {
  return [5, 15, 30][Math.max(0, Math.min(2, attempt - 1))]!;
}
