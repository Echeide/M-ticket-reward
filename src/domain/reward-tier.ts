export type RewardTierInput = { minimumCents: number; points: number; active: boolean };

export function normalizeRewardTierInput(value: Record<string, unknown>): RewardTierInput {
  const minimumCents = Number(value.minimumCents);
  const points = Number(value.points);
  if (!Number.isInteger(minimumCents) || minimumCents < 0 || minimumCents > 100_000_000) {
    throw new Error('TIER_MINIMUM_INVALID');
  }
  if (!Number.isInteger(points) || points < 0 || points > 1_000_000) {
    throw new Error('TIER_POINTS_INVALID');
  }
  return { minimumCents, points, active: value.active !== false };
}
