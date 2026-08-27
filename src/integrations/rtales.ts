import type { Env } from '../types';

type RtalesResponse = {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
};

export class RtalesApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly upstreamMessage: string,
  ) {
    super(`RTALES_API_ERROR:${status}`);
    this.name = 'RtalesApiError';
  }
}

export class RtalesTransportError extends Error {
  constructor(public readonly code: 'RTALES_TIMEOUT' | 'RTALES_NETWORK_ERROR') {
    super(code);
    this.name = 'RtalesTransportError';
  }
}

function rtalesTimeoutMs(env: Env): number {
  const configured = Number.parseInt(env.RTALES_TIMEOUT_MS || '', 10);
  if (!Number.isFinite(configured)) return 10_000;
  return Math.min(30_000, Math.max(1_000, configured));
}

function rtalesTransportError(pathname: string, caught: unknown): RtalesTransportError {
  const name = caught instanceof Error ? caught.name : '';
  const timedOut = ['TimeoutError', 'AbortError'].includes(name);
  const code = timedOut ? 'RTALES_TIMEOUT' : 'RTALES_NETWORK_ERROR';
  console.error('Rtales request failed', { pathname, code });
  return new RtalesTransportError(code);
}

export function retryAfterSeconds(response: Response, now = Date.now()): number {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, seconds);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.min(3600, Math.max(0, Math.ceil((timestamp - now) / 1000)));
}

async function rtalesRequest(
  env: Env,
  pathname: string,
  body: unknown,
  idempotencyKey?: string,
  method: 'GET' | 'POST' = 'POST',
): Promise<{ response: Response; payload: RtalesResponse }> {
  let response: Response;
  try {
    response = await fetch(new URL(pathname, env.RTALES_BASE_URL), {
      method,
      headers: {
        Authorization: `Bearer ${env.RTALES_EXTERNAL_GAME_TOKEN}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(rtalesTimeoutMs(env)),
    });
  } catch (caught) {
    throw rtalesTransportError(pathname, caught);
  }
  const contentType = response.headers.get('content-type') || '';
  let rawPayload = '';
  try {
    rawPayload = await response.text();
  } catch (caught) {
    throw rtalesTransportError(pathname, caught);
  }
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
    throw new RtalesApiError(
      result.response.status,
      String(result.payload.error || 'Rtales exchange failed'),
    );
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

export async function loadRtalesRewardCatalog(env: Env) {
  return rtalesRequest(env, '/api/integrations/external-games/reward-catalog', undefined, undefined, 'GET');
}

export async function grantStablePlayerReward(
  env: Env,
  input: {
    installationId: string;
    playerSubject: string;
    playerLookupCode: string;
    familyId: string;
    externalMatchId: string;
    eventType: string;
    cardId?: string;
    metadata?: Record<string, unknown>;
    idempotencyKey: string;
  },
) {
  return rtalesRequest(
    env,
    '/api/integrations/external-games/player-rewards',
    {
      installationId: input.installationId,
      playerSubject: input.playerSubject,
      playerLookupCode: input.playerLookupCode,
      familyId: input.familyId,
      externalMatchId: input.externalMatchId,
      eventType: input.eventType,
      points: 0,
      ...(input.cardId ? { cardIds: [input.cardId] } : { cardRewardCount: 1 }),
      metadata: input.metadata || {},
    },
    input.idempotencyKey,
  );
}
