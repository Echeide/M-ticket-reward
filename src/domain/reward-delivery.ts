import type { Env } from '../types';

const DEFAULT_MAX_ATTEMPTS = 8;
const MAX_CONFIGURED_ATTEMPTS = 20;

export function rewardMaxAttempts(env: Pick<Env, 'RTALES_REWARD_MAX_ATTEMPTS'>): number {
  const configured = Number.parseInt(env.RTALES_REWARD_MAX_ATTEMPTS || '', 10);
  if (!Number.isFinite(configured)) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(MAX_CONFIGURED_ATTEMPTS, Math.max(1, configured));
}

export function rewardRetryDelaySeconds(attempt: number, retryAfterSeconds = 0): number {
  const exponentialDelay = Math.min(3600, 5 * (2 ** Math.max(1, attempt)));
  return Math.min(3600, Math.max(exponentialDelay, Math.max(0, retryAfterSeconds)));
}

export function isRetryableRewardFailure(status: number, failure: string): boolean {
  if (status >= 500 || [408, 425, 429].includes(status)) return true;
  return failure.trim().toLowerCase().includes('game session is not ready to receive results');
}

export function rewardFailureMinimumDelaySeconds(failure: string): number {
  return failure.trim().toLowerCase().includes('game session is not ready to receive results') ? 30 : 0;
}

export function canResumeRewardInNewSession(
  receiptStatus: string,
  outboxStatus: string,
  lastError: string | null,
): boolean {
  if (receiptStatus === 'REWARD_PENDING' && ['PENDING', 'PROCESSING'].includes(outboxStatus)) return true;
  if (receiptStatus !== 'REWARD_FAILED' || outboxStatus !== 'FAILED') return false;
  const failure = String(lastError || '').trim().toLowerCase();
  return failure.includes('game session is not ready to receive results') ||
    ['rtales_max_attempts', 'rtales_delivery_timeout'].includes(failure);
}

export function databaseTimestampAfter(delaySeconds: number, now = Date.now()): string {
  return new Date(now + delaySeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
