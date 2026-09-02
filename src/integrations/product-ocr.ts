import type { ProductCampaignMatch } from '../domain/product-campaign';
import { normalizeProductCampaignMatches } from '../domain/product-campaign';
import type { Env } from '../types';
import { prepareOcrImageCandidates } from '../platform/image';
import { parseJsonObject } from './ocr';
import { createOcrProvider } from './ocr-provider';

export type ProductCampaignOcrInput = {
  id: string;
  name: string;
  productTerms: string[];
};

function productCampaignPrompt(campaigns: ProductCampaignOcrInput[]): string {
  return `Analiza exclusivamente las líneas de ARTÍCULOS COMPRADOS del ticket. Debes comprobar estas campañas:
${JSON.stringify(campaigns.map((campaign) => ({
    campaignId: campaign.id,
    campaignName: campaign.name,
    acceptedProductTexts: campaign.productTerms,
  })))}

Devuelve exclusivamente un JSON válido con esta forma:
{"matches":[{"campaignId":"...","matched":true,"confidence":0.95,"productText":"...","evidenceText":"línea literal completa del ticket"}]}

Incluye exactamente una entrada por campaña. matched=true únicamente cuando uno de sus textos aceptados
aparece realmente en una línea de producto comprado. La lista de productos es una ayuda de búsqueda, no
una prueba. No cuentes publicidad, cabeceras, cupones, promociones, métodos de pago ni textos fuera del
listado de artículos. evidenceText debe transcribir literalmente la línea visible que demuestra la compra.
Si la línea es dudosa, está cortada o no contiene el texto aceptado, devuelve matched=false. No inventes,
completes ni corrijas abreviaturas. Varias unidades del producto siguen siendo una sola coincidencia para
ese ticket.`;
}

export async function readProductCampaignMatches(
  env: Env,
  bytes: ArrayBuffer,
  contentType: string,
  campaigns: ProductCampaignOcrInput[],
): Promise<{ matches: ProductCampaignMatch[]; provider: string; model: string; durationMs: number }> {
  if (!campaigns.length) return { matches: [], provider: '', model: '', durationMs: 0 };
  if (env.OCR_MODE === 'mock') {
    return {
      matches: campaigns.map((campaign) => ({
        campaignId: campaign.id,
        matched: false,
        confidence: 0.99,
        productText: '',
        evidenceText: '',
      })),
      provider: 'mock', model: 'mock', durationMs: 0,
    };
  }
  const provider = createOcrProvider(env);
  const candidates = await prepareOcrImageCandidates(env, bytes, contentType);
  const startedAt = Date.now();
  const results: Array<{ matches: ProductCampaignMatch[]; provider: string; model: string }> = [];
  let candidateError: unknown;
  for (const candidate of candidates) {
    try {
      const response = await provider.extract({
        bytes: candidate.bytes,
        contentType: candidate.contentType,
        prompt: productCampaignPrompt(campaigns),
      });
      results.push({
        matches: normalizeProductCampaignMatches(parseJsonObject(response.text), campaigns),
        provider: response.provider,
        model: response.model,
      });
    } catch (caught) {
      candidateError = caught;
    }
  }
  if (!results.length) throw candidateError || new Error('OCR_PROCESSING_FAILED');
  const matches = campaigns.map((campaign) => {
    const options = results.map((result) => result.matches.find((match) =>
      match.campaignId === campaign.id)).filter((match): match is ProductCampaignMatch => Boolean(match));
    return options.find((match) => match.matched) ||
      options.sort((left, right) => right.confidence - left.confidence)[0]!;
  });
  return {
    matches,
    provider: results[0]!.provider,
    model: results[0]!.model,
    durationMs: Date.now() - startedAt,
  };
}
