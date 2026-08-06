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

export function databaseTimestampAfter(delaySeconds: number, now = Date.now()): string {
  return new Date(now + delaySeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
