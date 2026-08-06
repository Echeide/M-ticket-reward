import type { DbClient } from '../platform/db';

export type ExternalUserIdentity = {
  subject: string;
  lookupCode: string;
  displayName: string;
  email: string | null;
  language: string;
  spaceCode: string;
  installationId: string;
};

export type ExternalUserRow = {
  id: string;
  rtales_subject: string;
  rtales_lookup_code: string;
};

export function normalizeLookupCode(value: unknown): string {
  return String(value || '').normalize('NFKC').trim().toUpperCase().replace(/[\s-]+/g, '');
}

export function externalIdentityFromExchange(exchange: Record<string, unknown>): ExternalUserIdentity {
  const player = exchange.player && typeof exchange.player === 'object'
    ? exchange.player as Record<string, unknown>
    : {};
  const context = exchange.context && typeof exchange.context === 'object'
    ? exchange.context as Record<string, unknown>
    : {};
  const identity: ExternalUserIdentity = {
    subject: String(player.subject || '').trim(),
    lookupCode: String(player.lookupCode || '').trim().toUpperCase(),
    displayName: String(player.displayName || '').trim(),
    email: String(player.email || '').trim().toLowerCase() || null,
    language: String(player.language || '').trim().toLowerCase(),
    spaceCode: String(context.spaceCode || '').trim().toUpperCase(),
    installationId: String(context.installationId || '').trim(),
  };
  if (!identity.subject) throw new Error('RTALES_PLAYER_SUBJECT_REQUIRED');
  if (!identity.lookupCode || !normalizeLookupCode(identity.lookupCode)) {
    throw new Error('RTALES_PLAYER_LOOKUP_CODE_REQUIRED');
  }
  if (!identity.installationId || !identity.spaceCode) throw new Error('RTALES_CONTEXT_REQUIRED');
  return identity;
}

export function publicExternalPlayer(identity: ExternalUserIdentity) {
  return { displayName: identity.displayName };
}

export async function upsertExternalUser(
  client: DbClient,
  identity: ExternalUserIdentity,
  newId: string,
): Promise<ExternalUserRow> {
  const result = await client.query<ExternalUserRow>(
    `INSERT INTO external_users
       (id, rtales_subject, rtales_lookup_code, rtales_lookup_code_normalized,
        display_name, email, language, space_code, installation_id, last_accessed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT(rtales_subject) DO UPDATE SET
       rtales_lookup_code = $3, rtales_lookup_code_normalized = $4,
       display_name = $5, email = $6, language = $7, space_code = $8,
       installation_id = $9, last_accessed_at = NOW(), updated_at = NOW()
     RETURNING id, rtales_subject, rtales_lookup_code`,
    [newId, identity.subject, identity.lookupCode, normalizeLookupCode(identity.lookupCode),
      identity.displayName, identity.email, identity.language, identity.spaceCode,
      identity.installationId],
  );
  const user = result.rows[0];
  if (!user) throw new Error('EXTERNAL_USER_UPSERT_FAILED');
  return user;
}
