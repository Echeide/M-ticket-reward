export type ProductCampaignInput = {
  name: string;
  active: boolean;
  productTerms: string[];
  requiredTickets: number;
  installationId: string;
  familyId: string;
  cardId: string;
  startsOn: string;
  endsOn: string;
  maxAwardsTotal: number;
};

export type ProductCampaignMatch = {
  campaignId: string;
  matched: boolean;
  confidence: number;
  productText: string;
  evidenceText: string;
};

export function normalizeConfirmedProductCampaignIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  if (ids.length > 20 || ids.some((id) =>
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('PRODUCT_CAMPAIGN_CONFIRMATION_INVALID');
  }
  return ids;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('PRODUCT_CAMPAIGN_NUMBER_INVALID');
  }
  return parsed;
}

function optionalIsoDate(value: unknown): string {
  const date = String(value || '').trim();
  if (!date) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error('PRODUCT_CAMPAIGN_DATE_INVALID');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day) throw new Error('PRODUCT_CAMPAIGN_DATE_INVALID');
  return date;
}

export function normalizeProductCampaignText(value: string): string {
  return value.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('es')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeProductCampaignInput(value: Record<string, unknown>): ProductCampaignInput {
  const name = String(value.name || '').trim();
  const rawTerms = Array.isArray(value.productTerms)
    ? value.productTerms
    : String(value.productTerms || '').split(/[\n,;]/);
  const seenTerms = new Set<string>();
  const productTerms = rawTerms
    .map((term) => String(term || '').trim())
    .filter((term) => {
      if (!term) return false;
      const normalized = normalizeProductCampaignText(term);
      if (seenTerms.has(normalized)) return false;
      seenTerms.add(normalized);
      return true;
    })
    .slice(0, 30);
  const installationId = String(value.installationId || '').trim().slice(0, 100);
  const familyId = String(value.familyId || '').trim().slice(0, 100);
  const cardId = String(value.cardId || '').trim().slice(0, 100);
  const startsOn = optionalIsoDate(value.startsOn);
  const endsOn = optionalIsoDate(value.endsOn);

  if (name.length < 2 || name.length > 120) throw new Error('PRODUCT_CAMPAIGN_NAME_INVALID');
  if (!productTerms.length || productTerms.some((term) => term.length < 2 || term.length > 100)) {
    throw new Error('PRODUCT_CAMPAIGN_TERMS_INVALID');
  }
  if (!installationId || !familyId || !cardId) throw new Error('PRODUCT_CAMPAIGN_REWARD_REQUIRED');
  if (startsOn && endsOn && startsOn > endsOn) throw new Error('PRODUCT_CAMPAIGN_PERIOD_INVALID');

  return {
    name,
    active: value.active !== false,
    productTerms,
    requiredTickets: boundedInteger(value.requiredTickets, 1, 1_000),
    installationId,
    familyId,
    cardId,
    startsOn,
    endsOn,
    maxAwardsTotal: boundedInteger(value.maxAwardsTotal ?? 0, 0, 1_000_000),
  };
}

export function productEvidenceContainsTerm(evidence: string, terms: string[]): boolean {
  const normalizedEvidence = ` ${normalizeProductCampaignText(evidence)} `;
  return terms.some((term) => {
    const normalizedTerm = normalizeProductCampaignText(term);
    return normalizedTerm.length >= 2 && normalizedEvidence.includes(` ${normalizedTerm} `);
  });
}

export function normalizeProductCampaignMatches(
  value: unknown,
  campaigns: Array<{ id: string; productTerms: string[] }>,
): ProductCampaignMatch[] {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawMatches = Array.isArray(record.matches) ? record.matches : [];
  const byCampaign = new Map(rawMatches.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const match = entry as Record<string, unknown>;
    return [[String(match.campaignId || ''), match] as const];
  }));
  return campaigns.map((campaign) => {
    const raw = byCampaign.get(campaign.id) || {};
    const confidenceValue = Number(raw.confidence);
    const confidence = Number.isFinite(confidenceValue)
      ? Math.max(0, Math.min(1, confidenceValue))
      : 0;
    const productText = String(raw.productText || '').trim().slice(0, 200);
    const evidenceText = String(raw.evidenceText || '').trim().slice(0, 500);
    const hasLiteralEvidence = productEvidenceContainsTerm(
      `${productText}\n${evidenceText}`,
      campaign.productTerms,
    );
    return {
      campaignId: campaign.id,
      matched: raw.matched === true && confidence >= 0.8 && hasLiteralEvidence,
      confidence,
      productText,
      evidenceText,
    };
  });
}
