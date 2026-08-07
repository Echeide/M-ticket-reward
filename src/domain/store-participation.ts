export const STORE_PARTICIPATION_LEVELS = [
  'STANDARD',
  'COLLABORATOR',
  'FEATURED',
  'SPONSOR',
] as const;

export type StoreParticipationLevel = typeof STORE_PARTICIPATION_LEVELS[number];

export const STORE_PARTICIPATION = {
  STANDARD: { label: 'Estándar', multiplierPercent: 100 },
  COLLABORATOR: { label: 'Colaborador', multiplierPercent: 125 },
  FEATURED: { label: 'Destacado', multiplierPercent: 150 },
  SPONSOR: { label: 'Patrocinador', multiplierPercent: 200 },
} satisfies Record<StoreParticipationLevel, { label: string; multiplierPercent: number }>;

export function isStoreParticipationLevel(value: unknown): value is StoreParticipationLevel {
  return typeof value === 'string' && STORE_PARTICIPATION_LEVELS.includes(value as StoreParticipationLevel);
}

export function normalizeStoreParticipationLevel(value: unknown): StoreParticipationLevel {
  return isStoreParticipationLevel(value) ? value : 'STANDARD';
}

export function requireStoreParticipationLevel(value: unknown): StoreParticipationLevel {
  if (value === undefined || value === null || value === '') return 'STANDARD';
  if (!isStoreParticipationLevel(value)) throw new Error('STORE_PARTICIPATION_LEVEL_INVALID');
  return value;
}

export function storeParticipationView(level: unknown) {
  const normalizedLevel = normalizeStoreParticipationLevel(level);
  return {
    participationLevel: normalizedLevel,
    participationLabel: STORE_PARTICIPATION[normalizedLevel].label,
    rewardMultiplierPercent: STORE_PARTICIPATION[normalizedLevel].multiplierPercent,
  };
}
