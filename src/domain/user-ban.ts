export const USER_BAN_SCORE_THRESHOLD = 6;

export type UserOffenseCategory = 'NOT_A_RECEIPT' | 'CONFIRMED_FRAUD';

export function userOffenseScore(category: UserOffenseCategory): number {
  return category === 'CONFIRMED_FRAUD' ? 2 : 1;
}

export function shouldBanUser(score: number): boolean {
  return Number.isFinite(score) && score >= USER_BAN_SCORE_THRESHOLD;
}
