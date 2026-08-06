export const USER_BAN_SCORE_THRESHOLD = 6;

export type UserOffenseCategory = 'NOT_A_RECEIPT' | 'CONFIRMED_FRAUD';

export function userOffenseScore(category: UserOffenseCategory): number {
  return category === 'CONFIRMED_FRAUD' ? 2 : 1;
}

export function shouldBanUser(score: number, threshold = USER_BAN_SCORE_THRESHOLD): boolean {
  return threshold > 0 && Number.isFinite(score) && score >= threshold;
}
