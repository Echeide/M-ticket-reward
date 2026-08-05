import type { Env } from '../types';

type RtalesResponse = {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
};

async function rtalesRequest(
  env: Env,
  pathname: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<{ response: Response; payload: RtalesResponse }> {
  const response = await fetch(new URL(pathname, env.RTALES_BASE_URL), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RTALES_EXTERNAL_GAME_TOKEN}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as RtalesResponse;
  return { response, payload };
}

export async function exchangeLaunchCode(env: Env, launchCode: string) {
  const result = await rtalesRequest(env, '/api/integrations/external-games/exchange', {
    launchCode,
  });
  if (!result.response.ok || !result.payload.success) {
    throw new Error(result.payload.error || 'RTALES_EXCHANGE_FAILED');
  }
  return result.payload;
}

export async function grantTicketPoints(
  env: Env,
  input: {
    gameSessionId: string;
    playerToken: string;
    receiptId: string;
    publicId: string;
    points: number;
    totalCents: number;
    idempotencyKey: string;
  },
) {
  return rtalesRequest(
    env,
    '/api/integrations/external-games/events',
    {
      gameSessionId: input.gameSessionId,
      playerToken: input.playerToken,
      eventType: 'TICKET_AUTO_VALIDATED',
      sequence: 1,
      isFinal: true,
      externalMatchId: input.receiptId,
      points: input.points,
      cardRewardCount: 0,
      metadata: {
        receiptPublicId: input.publicId,
        purchaseTotalCents: input.totalCents,
      },
    },
    input.idempotencyKey,
  );
}

export async function revokeTicketPoints(
  env: Env,
  input: {
    resultId: string;
    receiptId: string;
    reason: string;
    managerEmail: string;
    idempotencyKey: string;
  },
) {
  return rtalesRequest(
    env,
    '/api/integrations/external-games/reversals',
    {
      resultId: input.resultId,
      externalReference: input.receiptId,
      reason: input.reason,
      managerReference: input.managerEmail,
    },
    input.idempotencyKey,
  );
}
