import type { Env } from '../types';

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function error(message: string, status = 400, code?: string): Response {
  return json({ success: false, error: message, ...(code ? { code } : {}) }, status);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_JSON');
  }
  return value as Record<string, unknown>;
}

export function bearerToken(request: Request): string {
  return request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
}

export function managerIdentity(request: Request, env: Env): string | null {
  const accessEmail = request.headers.get('Cf-Access-Authenticated-User-Email')?.trim();
  if (accessEmail) return accessEmail;
  if (
    env.ALLOW_DEV_ADMIN === 'true' &&
    env.DEV_ADMIN_TOKEN &&
    bearerToken(request) === env.DEV_ADMIN_TOKEN
  ) {
    return 'local-admin@development';
  }
  return null;
}

export function allowedParentOrigin(value: unknown, env: Env): string | null {
  try {
    const origin = new URL(String(value || '')).origin;
    const allowed = env.RTALES_PARENT_ORIGINS.split(',').map((item) => item.trim());
    return allowed.includes(origin) ? origin : null;
  } catch {
    return null;
  }
}
