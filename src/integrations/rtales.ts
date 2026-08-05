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
  const contentType = response.headers.get('content-type') || '';
  const rawPayload = await response.text();
  let payload: RtalesResponse = {};
  try {
    payload = JSON.parse(rawPayload) as RtalesResponse;
  } catch {
    if (!response.ok) {
      console.error('Rtales returned a non-JSON response', {
        pathname,
        status: response.status,
        contentType,
      });
    }
  }
  return { response, payload };
}

export async function exchangeLaunchCode(env: Env, launchCode: string) {
  const result = await rtalesRequest(env, '/api/integrations/external-games/exchange', {
    launchCode,
  });
  if (!result.response.ok || !result.payload.success) {
    console.error('Rtales exchange rejected', {
      status: result.response.status,
      error: result.payload.error || null,
    });
    throw new Error(`RTALES_EXCHANGE_FAILED:${result.response.status}`);
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
