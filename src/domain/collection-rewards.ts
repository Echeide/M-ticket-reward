export type CollectionMilestone = {
  points: number;
  cardId: string;
};

export type CollectionDailyWinnerConfig = {
  enabled: boolean;
  metric: 'POINTS' | 'PURCHASES';
  minimumPurchases: number;
  cardId: string;
};

export type StoreCollectionConfig = {
  enabled: boolean;
  categoryCode: string;
  installationId: string;
  familyId: string;
  milestones: CollectionMilestone[];
  maxCardsTotal: number;
  maxCardsPerUser: number;
  dailyWinner: CollectionDailyWinnerConfig;
};

const EMPTY_CONFIG: StoreCollectionConfig = {
  enabled: false,
  categoryCode: '',
  installationId: '',
  familyId: '',
  milestones: [],
  maxCardsTotal: 0,
  maxCardsPerUser: 0,
  dailyWinner: { enabled: false, metric: 'POINTS', minimumPurchases: 1, cardId: '' },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : fallback;
}

export function normalizeStoreCollectionConfig(value: unknown): StoreCollectionConfig {
  const input = record(value);
  const daily = record(input.dailyWinner);
  const milestones = Array.isArray(input.milestones)
    ? input.milestones.flatMap((entry) => {
        const milestone = record(entry);
        const points = boundedInteger(milestone.points, 0, 10_000_000);
        const cardId = String(milestone.cardId || '').trim().slice(0, 100);
        return points > 0 ? [{ points, cardId }] : [];
      })
    : [];
  const uniqueMilestones = Array.from(
    new Map(milestones.map((milestone) => [milestone.points, milestone])).values(),
  ).sort((left, right) => left.points - right.points).slice(0, 20);
  const metric = String(daily.metric || '').toUpperCase() === 'PURCHASES' ? 'PURCHASES' : 'POINTS';
  return {
    enabled: input.enabled === true,
    categoryCode: String(input.categoryCode || '').trim().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40),
    installationId: String(input.installationId || '').trim().slice(0, 100),
    familyId: String(input.familyId || '').trim().slice(0, 100),
    milestones: uniqueMilestones,
    maxCardsTotal: boundedInteger(input.maxCardsTotal, 0, 1_000_000),
    maxCardsPerUser: boundedInteger(input.maxCardsPerUser, 0, 10_000),
    dailyWinner: {
      enabled: daily.enabled === true,
      metric,
      minimumPurchases: Math.max(1, boundedInteger(daily.minimumPurchases, 1, 1_000)),
      cardId: String(daily.cardId || '').trim().slice(0, 100),
    },
  };
}

export function requireStoreCollectionConfig(value: unknown): StoreCollectionConfig {
  const config = normalizeStoreCollectionConfig(value);
  if (!config.enabled) return config;
  if (!config.installationId || !config.familyId) throw new Error('STORE_COLLECTION_TARGET_REQUIRED');
  if (!config.milestones.length && !config.dailyWinner.enabled) {
    throw new Error('STORE_COLLECTION_RULE_REQUIRED');
  }
  if (config.dailyWinner.enabled && !config.categoryCode) {
    throw new Error('STORE_COLLECTION_CATEGORY_REQUIRED');
  }
  return config;
}

export function crossedCollectionMilestones(totalPoints: number, config: StoreCollectionConfig) {
  if (!config.enabled || totalPoints <= 0) return [];
  return config.milestones.filter((milestone) => milestone.points <= totalPoints);
}

export function emptyStoreCollectionConfig(): StoreCollectionConfig {
  return structuredClone(EMPTY_CONFIG);
}
