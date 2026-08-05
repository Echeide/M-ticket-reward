export type RewardTier = {
  id: string;
  minimumCents: number;
  points: number;
  active: boolean;
};

export function resolveRewardPoints(
  totalCents: number,
  tiers: RewardTier[],
): number {
  const eligible = tiers
    .filter((tier) => tier.active && tier.minimumCents <= totalCents)
    .sort((left, right) => right.minimumCents - left.minimumCents);
  return Math.max(0, Math.trunc(eligible[0]?.points ?? 0));
}

export function rewardIdempotencyKey(receiptId: string): string {
  return `ticket:${receiptId}:grant:v1`;
}

export function reversalIdempotencyKey(receiptId: string): string {
  return `ticket:${receiptId}:revoke:v1`;
}
