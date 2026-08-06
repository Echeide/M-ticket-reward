import type { DbClient } from './platform/db';
import { buildTicketFingerprint } from './domain/deduplication';
import {
  type OcrReceipt,
  type ReceiptFields,
  canReprocessReceipt,
  isValidIsoDate,
  isValidPurchaseDateTime,
  receiptStatusAfterOcr,
  validateReceiptAutomatically,
} from './domain/receipt';
import {
  resolveRewardPoints,
  reversalIdempotencyKey,
  rewardIdempotencyKey,
} from './domain/rewards';
import {
  databaseTimestampAfter,
  rewardMaxAttempts,
  rewardRetryDelaySeconds,
} from './domain/reward-delivery';
import { findMatchingStore, normalizeStoreInput } from './domain/store';
import {
  compareTrainingResult,
  normalizeTrainingSampleInput,
  trainingEvaluationPassed,
  type TrainingEvaluationMatches,
} from './domain/training-sample';
import {
  generateStoreOcrProfile,
  normalizeStoreOcrProfile,
  type StoreOcrProfile,
} from './domain/ocr-profile';
import { normalizeRewardTierInput } from './domain/reward-tier';
import { normalizeAdminEmail, type AdminRole } from './domain/admin-user';
import { shouldBanUser, userOffenseScore, USER_BAN_SCORE_THRESHOLD, type UserOffenseCategory } from './domain/user-ban';
import {
  externalIdentityFromExchange,
  normalizeLookupCode,
  publicExternalPlayer,
  upsertExternalUser,
} from './domain/external-user';
import {
  APP_SETTING_DEFINITIONS,
  appSettingsWithDefaults,
  normalizeAppSettingValue,
  settingDefinition,
  validateAppSettingPeriod,
} from './domain/app-settings';
import { readReceipt } from './integrations/ocr';
import { classifyOcrFailure, ocrMaxAttempts, ocrRetryDelaySeconds } from './domain/ocr-failure';
import { syncAdminAccessEmails } from './integrations/cloudflare-access';
import { adminInvitationMailConfigured, sendAdminInvitation } from './integrations/mailjet';
import {
  exchangeLaunchCode,
  grantTicketPoints,
  RtalesApiError,
  RtalesTransportError,
  retryAfterSeconds,
  revokeTicketPoints,
} from './integrations/rtales';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from './platform/crypto';
import { inTransaction, withDatabase } from './platform/db';
import { optimizeStoreLogo, optimizeTicketImage, prepareOcrImage } from './platform/image';
import {
  allowedParentOrigin,
  bearerToken,
  error,
  json,
  managerIdentity,
  readJson,
} from './platform/http';
import type { Env, JobMessage } from './types';

type SessionRow = {
  id: string;
  external_user_id: string | null;
  user_ref: string;
  rtales_lookup_code: string | null;
  rtales_game_session_id: string;
  player_token_encrypted: string;
  parent_origin: string | null;
  display_name: string | null;
  user_email: string | null;
  language: string | null;
  space_code: string | null;
  installation_id: string | null;
};

type ReceiptRow = {
  id: string;
  public_id: string;
  session_id: string;
  external_user_id: string | null;
  user_ref: string;
  image_key: string;
  image_content_type: string;
  image_sha256: string;
  status: string;
  store_id: string | null;
  store_name: string | null;
  ticket_number: string | null;
  purchase_date: string | null;
  total_cents: number | null;
  currency: string;
  ticket_fingerprint: string | null;
  ocr_payload: OcrReceipt | null;
  ocr_confidence: number | null;
  ocr_provider: string | null;
  ocr_model: string | null;
  ocr_attempt_count: number;
  ocr_duration_ms: number | null;
  ocr_started_at: string | null;
  ocr_completed_at: string | null;
  ocr_job_attempt_count: number;
  ocr_last_error: string | null;
  risk_score: number;
  validation_reasons: string[];
  review_status: 'PENDING' | 'CLEARED' | 'FRAUD';
  reviewed_at: string | null;
  reviewed_by: string | null;
  user_display_name?: string | null;
  user_email?: string | null;
  user_lookup_code?: string | null;
  user_space_code?: string | null;
  user_installation_id?: string | null;
  rtales_lookup_code_snapshot: string | null;
  points_awarded: number;
  rtales_result_id: string | null;
  rtales_reversal_id: string | null;
  created_at: string;
  rewarded_at: string | null;
  revoked_at: string | null;
  deletion_requested_at: string | null;
  deletion_requested_by: string | null;
};

type StoreRow = {
  id: string;
  code: string;
  name: string;
  aliases: string[];
  active: boolean;
  ocr_profile: StoreOcrProfile | null;
  logo_key: string | null;
  logo_content_type: string | null;
  logo_width: number | null;
  logo_height: number | null;
  logo_size: number | null;
  logo_updated_at: string | null;
  created_at: string;
  updated_at: string;
  receipt_count?: string;
};

type TrainingSampleRow = {
  id: string;
  store_id: string;
  image_key: string;
  image_content_type: string;
  image_size: number;
  image_width: number;
  image_height: number;
  expected_ticket_number: string;
  expected_purchase_date: string;
  expected_purchase_datetime: string | null;
  expected_total_cents: number;
  expected_currency: string;
  notes: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  evaluation_id?: string | null;
  evaluation_provider?: string | null;
  evaluation_model?: string | null;
  evaluation_status?: 'PASSED' | 'FAILED' | 'ERROR' | null;
  evaluation_matches?: TrainingEvaluationMatches | null;
  evaluation_verification_issues?: string[] | null;
  evaluation_attempt_count?: number | null;
  evaluation_duration_ms?: number | null;
  evaluation_error_message?: string | null;
  evaluation_created_at?: string | null;
};

type TrainingEvaluationRow = {
  id: string;
  sample_id: string;
  provider: string;
  model: string;
  status: 'PASSED' | 'FAILED' | 'ERROR';
  actual_payload: OcrReceipt | null;
  matches: TrainingEvaluationMatches;
  verification_issues: string[];
  attempt_count: number;
  duration_ms: number | null;
  error_message: string | null;
  created_by: string;
  created_at: string;
};

type TrainingReceiptCandidateRow = {
  id: string;
  public_id: string;
  status: string;
  ticket_number: string | null;
  purchase_date: string | null;
  ocr_payload: OcrReceipt | null;
  total_cents: number | null;
  currency: string;
  created_at: string;
  user_ref: string;
  user_display_name?: string | null;
  user_email?: string | null;
};

type RewardTierRow = {
  id: string;
  minimum_cents: number;
  points: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type AppSettingRow = {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
};

type AdminUserRow = {
  id: string;
  email: string;
  role: AdminRole;
  active: boolean;
  created_by: string;
  created_at: string;
  last_accessed_at: string | null;
};

type UserBanRow = {
  id: string;
  external_user_id: string;
  status: 'MONITORING' | 'ACTIVE' | 'LIFTING' | 'LIFTED';
  offense_score: number;
  reason: string | null;
  banned_at: string | null;
  banned_by: string | null;
  lifting_at: string | null;
  lifting_by: string | null;
  lifted_at: string | null;
  updated_at: string;
};

const ACTIVE_DUPLICATE_STATUSES = [
  'OCR_QUEUED',
  'OCR_PROCESSING',
  'READY_FOR_CONFIRMATION',
  'REWARD_PENDING',
  'REWARDED',
  'REWARD_FAILED',
  'REVOKE_PENDING',
] as const;

function uuid(): string {
  return crypto.randomUUID();
}

function publicId(): string {
  return `TKT-${randomToken(8).toUpperCase()}`;
}

function sessionView(row: SessionRow) {
  return {
    displayName: row.display_name,
    parentOrigin: row.parent_origin,
  };
}

function receiptView(row: ReceiptRow, includeManagerFields = false) {
  const verificationRequired = row.status === 'REWARD_FAILED' &&
    row.validation_reasons.includes('OCR_VERIFICATION_REQUIRED');
  return {
    id: row.id,
    publicId: row.public_id,
    status: row.status,
    fields: {
      storeId: row.store_id || '',
      storeName: row.store_name || '',
      ticketNumber: row.ticket_number || '',
      purchaseDate: row.purchase_date || '',
      purchaseDateTime: row.ocr_payload?.purchaseDateTime || '',
      totalCents: row.total_cents || 0,
      currency: row.currency,
    },
    ocr: row.ocr_payload,
    riskScore: row.risk_score,
    reasons: row.validation_reasons,
    verificationRequired,
    ocrProcessing: {
      provider: row.ocr_provider,
      model: row.ocr_model,
      attemptCount: row.ocr_attempt_count,
      durationMs: row.ocr_duration_ms,
      startedAt: row.ocr_started_at,
      completedAt: row.ocr_completed_at,
      ...(includeManagerFields ? {
        jobAttemptCount: row.ocr_job_attempt_count,
        lastError: row.ocr_last_error,
      } : {}),
    },
    review: {
      status: row.review_status,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by,
    },
    ...(includeManagerFields ? {
      user: {
        subject: row.user_ref,
        lookupCode: row.user_lookup_code || row.rtales_lookup_code_snapshot || '',
        displayName: row.user_display_name || '',
        email: row.user_email || '',
        spaceCode: row.user_space_code || '',
        installationId: row.user_installation_id || '',
      },
    } : {}),
    reward: {
      pointsAwarded: row.points_awarded,
      resultId: row.rtales_result_id,
      reversalId: row.rtales_reversal_id,
    },
    createdAt: row.created_at,
    rewardedAt: row.rewarded_at,
    revokedAt: row.revoked_at,
  };
}

const PUBLIC_REASON_MESSAGES: Record<string, string> = {
  OCR_PROCESSING_FAILED: 'No hemos podido leer el ticket. Prueba con una foto más clara.',
  OCR_PROVIDER_QUOTA_EXCEEDED: 'No hemos podido procesar el ticket en este momento. El ticket queda registrado para poder volver a comprobarlo.',
  OCR_PROVIDER_LICENSE_REQUIRED: 'No hemos podido procesar el ticket en este momento. El ticket queda registrado para poder volver a comprobarlo.',
  OCR_PROVIDER_CONFIGURATION_ERROR: 'No hemos podido procesar el ticket en este momento. El ticket queda registrado para poder volver a comprobarlo.',
  OCR_PROVIDER_CAPACITY: 'El servicio de lectura está saturado temporalmente. El ticket queda registrado para poder volver a comprobarlo.',
  OCR_PROVIDER_RATE_LIMITED: 'El servicio de lectura está saturado temporalmente. El ticket queda registrado para poder volver a comprobarlo.',
  OCR_PROVIDER_TIMEOUT: 'El servicio de lectura ha tardado demasiado. El ticket queda registrado para poder volver a comprobarlo.',
  OCR_PROVIDER_UNAVAILABLE: 'El servicio de lectura no está disponible temporalmente. El ticket queda registrado para poder volver a comprobarlo.',
  OCR_VERIFICATION_REQUIRED: 'El ticket está registrado, pero no hemos podido verificar todos sus datos automáticamente. Queda pendiente de revisión.',
  NOT_A_RECEIPT: 'La imagen no parece un ticket de compra.',
  DUPLICATE: 'Este ticket ya se había enviado.',
  DUPLICATE_IMAGE: 'Esta imagen ya se había enviado.',
  STORE_NOT_ALLOWED: 'El comercio no está autorizado.',
  TICKET_NUMBER_REQUIRED: 'No se pudo reconocer el número del ticket.',
  TICKET_NUMBER_OR_TIME_REQUIRED: 'No se pudo reconocer un número de ticket ni una hora de compra verificable.',
  INVALID_TOTAL: 'No se pudo validar el importe del ticket.',
  INVALID_DATE: 'No se pudo reconocer una fecha válida.',
  FUTURE_DATE: 'La fecha está fuera del periodo permitido.',
  TICKET_TOO_OLD: 'La fecha está fuera del periodo permitido.',
  RTALES_DELIVERY_FAILED: 'No hemos podido añadir los puntos. El ticket sigue registrado y puedes reintentar la asignación.',
};

function publicReceiptMessage(row: ReceiptRow): string {
  const reasons = Array.isArray(row.validation_reasons) ? row.validation_reasons : [];
  const reason = reasons.find((value) => PUBLIC_REASON_MESSAGES[value]);
  if (reason) return PUBLIC_REASON_MESSAGES[reason]!;
  if (row.status === 'REVOKED') return 'El ticket fue anulado tras la revisión antifraude.';
  if (row.status === 'REVOKE_PENDING') return 'La anulación de los puntos está en proceso.';
  if (row.status === 'REWARD_PENDING') {
    return `Estamos asignando ${row.points_awarded} puntos. Puedes cerrar esta pantalla y consultar el resultado más tarde.`;
  }
  if (row.status === 'REWARD_FAILED') return 'No hemos podido completar la asignación de puntos.';
  return '';
}

function publicReceiptView(row: ReceiptRow) {
  const verificationRequired = row.status === 'REWARD_FAILED' &&
    row.validation_reasons.includes('OCR_VERIFICATION_REQUIRED');
  const retryableReward = row.status === 'REWARD_FAILED' &&
    row.validation_reasons.includes('RTALES_DELIVERY_FAILED');
  return {
    id: row.id,
    publicId: row.public_id,
    status: row.status,
    fields: {
      storeId: row.store_id || '',
      storeName: row.store_name || '',
      ticketNumber: row.ticket_number || '',
      purchaseDate: row.purchase_date || '',
      purchaseDateTime: row.ocr_payload?.purchaseDateTime || '',
      totalCents: row.total_cents || 0,
      currency: row.currency,
    },
    reward: { pointsAwarded: row.points_awarded },
    verificationRequired,
    retryableReward,
    message: publicReceiptMessage(row),
    createdAt: row.created_at,
    rewardedAt: row.rewarded_at,
    revokedAt: row.revoked_at,
  };
}

async function authenticatedSession(
  request: Request,
  env: Env,
  client?: DbClient,
): Promise<SessionRow | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const query = async (database: DbClient) => {
    const result = await database.query<SessionRow>(
      `SELECT id, user_ref, rtales_game_session_id, player_token_encrypted,
              external_user_id, rtales_lookup_code, parent_origin, display_name, user_email,
              language, space_code, installation_id
         FROM player_sessions
        WHERE access_token_hash = $1 AND expires_at > NOW()
        LIMIT 1`,
      [tokenHash],
    );
    return result.rows[0] ?? null;
  };
  return client ? query(client) : withDatabase(env, query);
}

async function handleReceiptImage(request: Request, env: Env, receiptId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  if (!session) return error('Sesión no válida', 401);
  const receipt = await withDatabase(env, async (client) => {
    const result = await client.query<Pick<ReceiptRow, 'image_key' | 'image_content_type'>>(
      'SELECT image_key, image_content_type FROM receipts WHERE id = $1 AND user_ref = $2 LIMIT 1',
      [receiptId, session.user_ref],
    );
    return result.rows[0];
  });
  if (!receipt) return error('Ticket no encontrado', 404);
  const object = await env.TICKETS.get(receipt.image_key);
  if (!object) return error('Imagen no encontrada', 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': receipt.image_content_type,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline',
    },
  });
}

async function handleExchange(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const launchCode = String(body.launchCode || '').trim();
  if (!launchCode.startsWith('rtgl_')) return error('Código de lanzamiento inválido', 400);
  const exchange = await exchangeLaunchCode(env, launchCode);
  let identity;
  try {
    identity = externalIdentityFromExchange(exchange);
  } catch (caught) {
    const code = caught instanceof Error ? caught.message : 'RTALES_IDENTITY_REQUIRED';
    return error('Respuesta de identidad incompleta del sistema', 502, code);
  }
  const gameSessionId = String(exchange.gameSessionId || '');
  const playerToken = String(exchange.playerToken || '');
  if (!gameSessionId || !playerToken) return error('Respuesta incompleta del sistema', 502);

  const sessionToken = `tkts_${randomToken()}`;
  const sessionId = uuid();
  const parentOrigin = allowedParentOrigin(body.parentOrigin, env);
  const encryptedPlayerToken = await encryptSecret(playerToken, env.DATA_ENCRYPTION_KEY);
  await withDatabase(env, (client) => inTransaction(client, async () => {
    const externalUser = await upsertExternalUser(client, identity, uuid());
    await client.query(
      `INSERT INTO player_sessions
         (id, access_token_hash, external_user_id, user_ref, rtales_lookup_code,
          rtales_game_session_id, player_token_encrypted, parent_origin, display_name,
          user_email, language, space_code, installation_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         NOW() + INTERVAL '24 hours')
       ON CONFLICT(rtales_game_session_id) DO UPDATE SET
         access_token_hash = $2, external_user_id = $3, user_ref = $4,
         rtales_lookup_code = $5, player_token_encrypted = $7, parent_origin = $8,
         display_name = $9, user_email = $10, language = $11, space_code = $12,
         installation_id = $13, expires_at = NOW() + INTERVAL '24 hours'`,
      [
        sessionId,
        await sha256Hex(sessionToken),
        externalUser.id,
        identity.subject,
        identity.lookupCode,
        gameSessionId,
        encryptedPlayerToken,
        parentOrigin,
        identity.displayName,
        identity.email,
        identity.language,
        identity.spaceCode,
        identity.installationId,
      ],
    );
  }));
  return json({
    success: true,
    sessionToken,
    player: publicExternalPlayer(identity),
    parentOrigin,
  }, 201);
}

async function activeUserBan(client: DbClient, externalUserId: string | null): Promise<UserBanRow | null> {
  if (!externalUserId) return null;
  const result = await client.query<UserBanRow>(
    `SELECT * FROM user_bans WHERE external_user_id = $1
      AND status IN ('ACTIVE', 'LIFTING') LIMIT 1`,
    [externalUserId],
  );
  return result.rows[0] || null;
}

async function recordUserOffense(
  client: DbClient,
  receipt: Pick<ReceiptRow, 'id' | 'public_id' | 'external_user_id'>,
  category: UserOffenseCategory,
  source: 'AUTOMATIC' | 'ADMIN',
  actor: string,
): Promise<UserBanRow | null> {
  if (!receipt.external_user_id) return null;
  const score = userOffenseScore(category);
  const offense = await client.query<{ id: string }>(
    `INSERT INTO user_offenses
       (id, external_user_id, receipt_id, receipt_public_id, category, score, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(receipt_id, category) DO NOTHING RETURNING id`,
    [uuid(), receipt.external_user_id, receipt.id, receipt.public_id, category, score, source],
  );
  if (!offense.rowCount) return activeUserBan(client, receipt.external_user_id);
  const result = await client.query<UserBanRow>(
    `INSERT INTO user_bans
       (id, external_user_id, status, offense_score, reason, banned_at, banned_by, updated_at)
     VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NOW())
     ON CONFLICT(external_user_id) DO UPDATE SET
       offense_score = CASE WHEN user_bans.status = 'LIFTED' THEN excluded.offense_score
         ELSE user_bans.offense_score + excluded.offense_score END,
       status = CASE WHEN (CASE WHEN user_bans.status = 'LIFTED' THEN excluded.offense_score
         ELSE user_bans.offense_score + excluded.offense_score END) >= $5 THEN 'ACTIVE'
         ELSE 'MONITORING' END,
       reason = CASE WHEN (CASE WHEN user_bans.status = 'LIFTED' THEN excluded.offense_score
         ELSE user_bans.offense_score + excluded.offense_score END) >= $5
         THEN $6 ELSE NULL END,
       banned_at = CASE WHEN (CASE WHEN user_bans.status = 'LIFTED' THEN excluded.offense_score
         ELSE user_bans.offense_score + excluded.offense_score END) >= $5
         THEN COALESCE(user_bans.banned_at, NOW()) ELSE NULL END,
       banned_by = CASE WHEN (CASE WHEN user_bans.status = 'LIFTED' THEN excluded.offense_score
         ELSE user_bans.offense_score + excluded.offense_score END) >= $5
         THEN COALESCE(user_bans.banned_by, $7) ELSE NULL END,
       lifting_at = NULL, lifting_by = NULL, lifted_at = NULL, updated_at = NOW()
     RETURNING *`,
    [uuid(), receipt.external_user_id, shouldBanUser(score) ? 'ACTIVE' : 'MONITORING', score,
      USER_BAN_SCORE_THRESHOLD, `Límite automático de ${USER_BAN_SCORE_THRESHOLD} infracciones alcanzado`, actor],
  );
  return result.rows[0] || null;
}

async function clearAutomaticNonTicketOffense(
  client: DbClient,
  receiptId: string,
  externalUserId: string | null,
): Promise<void> {
  if (!externalUserId) return;
  const cleared = await client.query<{ id: string }>(
    `UPDATE user_offenses SET active = FALSE, cleared_at = NOW()
      WHERE receipt_id = $1 AND category = 'NOT_A_RECEIPT' AND source = 'AUTOMATIC'
        AND active = TRUE RETURNING id`,
    [receiptId],
  );
  if (!cleared.rowCount) return;
  const score = await client.query<{ total: number }>(
    `SELECT COALESCE(SUM(score), 0) AS total FROM user_offenses
      WHERE external_user_id = $1 AND active = TRUE`, [externalUserId],
  );
  await client.query(
    `UPDATE user_bans SET offense_score = $2, updated_at = NOW()
      WHERE external_user_id = $1`, [externalUserId, Number(score.rows[0]?.total || 0)],
  );
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const session = await authenticatedSession(request, env);
  if (!session) return error('Sesión no válida', 401);
  const ban = await withDatabase(env, (client) => activeUserBan(client, session.external_user_id));
  if (ban) {
    return error('Tu acceso al envío de tickets está suspendido. Contacta con la organización si consideras que se trata de un error.', 403, 'USER_BANNED');
  }
  const form = await request.formData();
  const image = form.get('ticket');
  if (!(image instanceof File)) return error('Selecciona una imagen del ticket', 400);
  const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!acceptedTypes.has(image.type)) return error('Formato de imagen no admitido', 415);
  const maximumBytes = Math.min(15 * 1024 * 1024, Number(env.MAX_TICKET_BYTES) || 10 * 1024 * 1024);
  if (image.size <= 0 || image.size > maximumBytes) return error('La imagen supera el tamaño permitido', 413);

  const originalBytes = await image.arrayBuffer();
  const storedImage = await optimizeTicketImage(env, originalBytes, image.type);
  const digest = await sha256Hex(storedImage.bytes);
  const receiptId = uuid();
  const ticketPublicId = publicId();
  const objectKey = `receipts/${session.user_ref}/${new Date().getUTCFullYear()}/${receiptId}/optimized.${storedImage.extension}`;

  const duplicate = await withDatabase(env, async (client) => {
    const existing = await client.query(
      `SELECT id FROM receipts
        WHERE user_ref = $1 AND image_sha256 = $2 AND status = ANY($3::text[])
        LIMIT 1`,
      [session.user_ref, digest, [...ACTIVE_DUPLICATE_STATUSES]],
    );
    await env.TICKETS.put(objectKey, storedImage.bytes, {
      httpMetadata: { contentType: storedImage.contentType },
      customMetadata: {
        receiptId,
        userRef: session.user_ref,
        sha256: digest,
        originalBytes: String(storedImage.originalBytes),
        storedBytes: String(storedImage.bytes.byteLength),
        storedDimensions: `${storedImage.width}x${storedImage.height}`,
        ocrReady: String(storedImage.ocrReady),
      },
      sha256: digest,
    });
    await client.query(
      `INSERT INTO receipts
         (id, public_id, session_id, user_ref, image_key, image_sha256,
          image_content_type, image_size, status, validation_reasons,
          rtales_lookup_code_snapshot, external_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
      [
        receiptId,
        ticketPublicId,
        session.id,
        session.user_ref,
        objectKey,
        digest,
        storedImage.contentType,
        storedImage.bytes.byteLength,
        existing.rowCount ? 'DUPLICATE' : 'OCR_QUEUED',
        JSON.stringify(existing.rowCount ? ['DUPLICATE_IMAGE'] : []),
        session.rtales_lookup_code,
        session.external_user_id,
      ],
    );
    return Boolean(existing.rowCount);
  });

  if (!duplicate) await env.OCR_JOBS.send({ kind: 'OCR_RECEIPT', receiptId });
  return json({ success: true, receiptId, publicId: ticketPublicId, status: duplicate ? 'DUPLICATE' : 'OCR_QUEUED' }, 202);
}

async function handleStores(request: Request, env: Env): Promise<Response> {
  const session = await authenticatedSession(request, env);
  if (!session) return error('Sesión no válida', 401);
  const stores = await withDatabase(env, async (client) => {
    const result = await client.query<StoreRow>(
      'SELECT * FROM stores WHERE active = TRUE ORDER BY name ASC',
    );
    return result.rows;
  });
  return json({
    success: true,
    stores: stores.map((store) => ({
      id: store.id,
      code: store.code,
      name: store.name,
      aliases: store.aliases,
      logoUrl: store.logo_key
        ? `/api/stores/${store.id}/logo?v=${encodeURIComponent(store.logo_updated_at || store.logo_key)}`
        : '',
    })),
  });
}

async function loadAppSettings(client: DbClient): Promise<Record<string, string>> {
  const result = await client.query<Pick<AppSettingRow, 'key' | 'value'>>(
    'SELECT key, value FROM app_settings ORDER BY key ASC',
  );
  return appSettingsWithDefaults(result.rows);
}

async function handleHomeSettings(request: Request, env: Env): Promise<Response> {
  const session = await authenticatedSession(request, env);
  if (!session) return error('Sesión no válida', 401);
  const settings = await withDatabase(env, loadAppSettings);
  return json({ success: true, settings });
}

async function loadOwnedReceipt(
  client: DbClient,
  receiptId: string,
  session: SessionRow,
  lock = false,
): Promise<ReceiptRow | null> {
  const result = await client.query<ReceiptRow>(
    `SELECT * FROM receipts WHERE id = $1 AND user_ref = $2${lock ? ' FOR UPDATE' : ''}`,
    [receiptId, session.user_ref],
  );
  return result.rows[0] ?? null;
}

async function handleReceiptStatus(request: Request, env: Env, receiptId: string): Promise<Response> {
  return withDatabase(env, async (client) => {
    const session = await authenticatedSession(request, env, client);
    if (!session) return error('Sesión no válida', 401);
    const receipt = await loadOwnedReceipt(client, receiptId, session);
    if (!receipt) return error('Ticket no encontrado', 404);
    return json({ success: true, receipt: publicReceiptView(receipt), session: sessionView(session) });
  });
}

async function handleReceiptList(request: Request, env: Env): Promise<Response> {
  return withDatabase(env, async (client) => {
    const session = await authenticatedSession(request, env, client);
    if (!session) return error('Sesión no válida', 401);
    const result = await client.query<ReceiptRow>(
      `SELECT * FROM receipts
        WHERE user_ref = $1
          AND status <> 'DUPLICATE'
        ORDER BY created_at DESC, id DESC
        LIMIT 50`,
      [session.user_ref],
    );
    return json({ success: true, receipts: result.rows.map(publicReceiptView) });
  });
}

async function handleLatestPendingReceipt(request: Request, env: Env): Promise<Response> {
  return withDatabase(env, async (client) => {
    const session = await authenticatedSession(request, env, client);
    if (!session) return error('Sesión no válida', 401);
    const result = await client.query<ReceiptRow>(
      `SELECT * FROM receipts
        WHERE user_ref = $1
          AND status IN ('OCR_QUEUED', 'OCR_PROCESSING', 'READY_FOR_CONFIRMATION', 'REWARD_PENDING')
        ORDER BY created_at DESC LIMIT 1`,
      [session.user_ref],
    );
    return json({ success: true, receipt: result.rows[0] ? publicReceiptView(result.rows[0]) : null });
  });
}

async function handleConfirm(request: Request, env: Env, receiptId: string): Promise<Response> {
  let outboxId = '';
  const result = await withDatabase(env, async (client) =>
    inTransaction(client, async () => {
      const session = await authenticatedSession(request, env, client);
      if (!session) return { response: error('Sesión no válida', 401) };
      const receipt = await loadOwnedReceipt(client, receiptId, session, true);
      if (!receipt) return { response: error('Ticket no encontrado', 404) };
      if (receipt.status === 'REWARDED') {
        return {
          response: json({
            success: true,
            status: 'REWARDED',
            points: receipt.points_awarded,
          }),
        };
      }
      if (receipt.status === 'REWARD_PENDING') {
        return {
          response: json({
            success: true,
            status: 'REWARD_PENDING',
            points: receipt.points_awarded,
          }, 202),
        };
      }
      if (
        receipt.status === 'REWARD_FAILED' &&
        receipt.validation_reasons.includes('RTALES_DELIVERY_FAILED')
      ) {
        const failed = await client.query<{ id: string }>(
          `UPDATE reward_outbox SET status = 'PENDING', attempt_count = 0,
             next_attempt_at = NOW(), locked_until = NULL, last_error = NULL,
             updated_at = NOW()
           WHERE id = (
             SELECT id FROM reward_outbox
              WHERE receipt_id = $1 AND operation = 'GRANT' AND status = 'FAILED'
              ORDER BY created_at DESC LIMIT 1
           )
           RETURNING id`,
          [receiptId],
        );
        if (!failed.rows[0]) return { response: error('No hay una asignación recuperable', 409) };
        outboxId = failed.rows[0].id;
        await client.query(
          `UPDATE receipts SET status = 'REWARD_PENDING', validation_reasons = '[]'::jsonb,
             review_status = 'CLEARED', reviewed_at = NOW(), reviewed_by = 'SYSTEM',
             updated_at = NOW() WHERE id = $1`,
          [receiptId],
        );
        return {
          response: json({
            success: true,
            status: 'REWARD_PENDING',
            points: receipt.points_awarded,
          }, 202),
        };
      }
      if (receipt.status !== 'READY_FOR_CONFIRMATION') {
        return { response: error('El ticket no está listo para confirmar', 409) };
      }

      const stores = await client.query<StoreRow>('SELECT * FROM stores WHERE active = TRUE');
      const selectedStore = findMatchingStore(stores.rows, {
        storeName: receipt.store_name || receipt.ocr_payload?.storeName,
        headerText: receipt.ocr_payload?.headerText,
        rawText: receipt.ocr_payload?.rawText,
      });
      const fields: ReceiptFields = {
        storeId: selectedStore?.id || '',
        storeName: selectedStore?.name || receipt.store_name || '',
        ticketNumber: receipt.ticket_number || '',
        purchaseDate: receipt.purchase_date || '',
        purchaseDateTime: receipt.ocr_payload?.purchaseDateTime,
        totalCents: receipt.total_cents || 0,
        currency: /^[A-Z]{3}$/.test(receipt.currency || '') ? receipt.currency : 'EUR',
      };
      const fingerprint = buildTicketFingerprint(fields);
      const duplicate = await client.query(
        `SELECT id FROM receipts
          WHERE user_ref = $1 AND ticket_fingerprint = $2 AND id <> $3
            AND status = ANY($4::text[])
          LIMIT 1`,
        [session.user_ref, fingerprint, receiptId, [...ACTIVE_DUPLICATE_STATUSES]],
      );
      const appSettings = await loadAppSettings(client);
      const validation = validateReceiptAutomatically({
        fields,
        ocr: receipt.ocr_payload || { isReceipt: false, confidence: 0 },
        storeActive: selectedStore?.active === true,
        duplicate: Boolean(duplicate.rowCount),
        allowedPurchaseStart: appSettings['validation.startAt'],
        allowedPurchaseEnd: appSettings['validation.endAt'],
      });
      if (!validation.approved) {
        const status = validation.reasons.includes('DUPLICATE') ? 'DUPLICATE' : 'AUTO_REJECTED';
        await client.query(
          `UPDATE receipts SET status = $2, store_id = $3, store_name = $4,
             ticket_number = $5, purchase_date = $6, total_cents = $7,
             currency = $8, ticket_fingerprint = $9, risk_score = $10,
             validation_reasons = $11::jsonb, updated_at = NOW()
           WHERE id = $1`,
          [receiptId, status, selectedStore?.id || null, fields.storeName, fields.ticketNumber,
            fields.purchaseDate || null, fields.totalCents, fields.currency,
            status === 'DUPLICATE' ? null : fingerprint,
            validation.riskScore, JSON.stringify(validation.reasons)],
        );
        return { response: json({ success: true, status, reasons: validation.reasons }) };
      }

      const tiers = await client.query<{ id: string; minimum_cents: number; points: number; active: boolean }>(
        'SELECT id, minimum_cents, points, active FROM reward_tiers WHERE active = TRUE',
      );
      const points = resolveRewardPoints(
        fields.totalCents,
        tiers.rows.map((tier) => ({
          id: tier.id,
          minimumCents: tier.minimum_cents,
          points: tier.points,
          active: tier.active,
        })),
      );
      outboxId = uuid();
      await client.query(
        `UPDATE receipts SET status = 'REWARD_PENDING', session_id = $2,
           store_id = $3, store_name = $4, ticket_number = $5, purchase_date = $6,
           total_cents = $7, currency = $8, ticket_fingerprint = $9, risk_score = $10,
           validation_reasons = '[]'::jsonb, points_awarded = $11, updated_at = NOW()
         WHERE id = $1`,
        [receiptId, session.id, selectedStore!.id, selectedStore!.name, fields.ticketNumber,
          fields.purchaseDate, fields.totalCents, fields.currency, fingerprint,
          validation.riskScore, points],
      );
      await client.query(
        `INSERT INTO reward_outbox
           (id, receipt_id, operation, idempotency_key, payload)
         VALUES ($1, $2, 'GRANT', $3, $4::jsonb)`,
        [outboxId, receiptId, rewardIdempotencyKey(receiptId), JSON.stringify({ points })],
      );
      return { response: json({ success: true, status: 'REWARD_PENDING', points }, 202) };
    }),
  );
  if (outboxId) await env.REWARD_JOBS.send({ kind: 'DELIVER_REWARD', outboxId });
  return result.response;
}

async function recoverPendingRewardOutbox(env: Env, receiptId: string): Promise<string> {
  return withDatabase(env, async (client) => {
    const receipt = await client.query<{ points_awarded: number }>(
      `SELECT points_awarded FROM receipts
        WHERE id = $1 AND status = 'REWARD_PENDING' LIMIT 1`,
      [receiptId],
    );
    if (!receipt.rows[0]) return '';
    const existing = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM reward_outbox
        WHERE receipt_id = $1 AND operation = 'GRANT'
        ORDER BY created_at DESC LIMIT 1`,
      [receiptId],
    );
    if (existing.rows[0]) return existing.rows[0].status === 'PENDING' ? existing.rows[0].id : '';
    const outboxId = uuid();
    await client.query(
      `INSERT INTO reward_outbox
         (id, receipt_id, operation, idempotency_key, payload)
       VALUES ($1, $2, 'GRANT', $3, $4::jsonb)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [outboxId, receiptId, rewardIdempotencyKey(receiptId), JSON.stringify({
        points: receipt.rows[0].points_awarded,
        automatic: true,
        recovered: true,
      })],
    );
    const saved = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM reward_outbox
        WHERE receipt_id = $1 AND operation = 'GRANT'
        ORDER BY created_at DESC LIMIT 1`,
      [receiptId],
    );
    return saved.rows[0]?.status === 'PENDING' ? saved.rows[0].id : '';
  });
}

async function enqueueRewardOutbox(env: Env, receiptId: string, outboxId: string): Promise<void> {
  if (!outboxId) return;
  try {
    await env.REWARD_JOBS.send({ kind: 'DELIVER_REWARD', outboxId });
  } catch (caught) {
    // The scheduled outbox recovery will enqueue the pending delivery.
    console.error('Automatic reward enqueue failed', { receiptId, outboxId }, caught);
  }
}

async function processOcr(env: Env, receiptId: string): Promise<void> {
  const receipt = await withDatabase(env, async (client) => {
    const result = await client.query<Pick<ReceiptRow, 'id' | 'public_id' | 'external_user_id' | 'session_id' | 'user_ref' | 'image_key' | 'image_content_type' | 'status'>>(
      `UPDATE receipts SET status = 'OCR_PROCESSING', ocr_started_at = NOW(),
          ocr_completed_at = NULL,
          ocr_job_attempt_count = ocr_job_attempt_count + 1,
          updated_at = NOW()
        WHERE id = $1 AND status IN ('OCR_QUEUED', 'OCR_PROCESSING')
        RETURNING id, public_id, external_user_id, session_id, user_ref, image_key, image_content_type, status`,
      [receiptId],
    );
    return result.rows[0];
  });
  if (!receipt) {
    await enqueueRewardOutbox(env, receiptId, await recoverPendingRewardOutbox(env, receiptId));
    return;
  }
  const image = await env.TICKETS.get(receipt.image_key);
  if (!image) throw new Error('R2_OBJECT_NOT_FOUND');
  const storedBytes = await image.arrayBuffer();
  const ocrBytes = image.customMetadata?.ocrReady === 'true'
    ? storedBytes
    : await prepareOcrImage(env, storedBytes);
  const stores = await withDatabase(env, async (client) => {
    const result = await client.query<StoreRow>(
      'SELECT * FROM stores WHERE active = TRUE ORDER BY name ASC',
    );
    return result.rows.map(storeIdentity);
  });
  const ocrResult = await readReceipt(env, ocrBytes, receipt.image_content_type || 'image/webp', stores);
  const ocr = ocrResult.receipt;
  let rewardOutboxId = '';
  let completedStatus = '';
  await withDatabase(env, async (client) => {
    const appSettings = await loadAppSettings(client);
    const selectedStore = findMatchingStore(stores, ocr);
    const fields: ReceiptFields = {
      storeId: selectedStore?.id || '',
      storeName: selectedStore?.name || ocr.storeName || '',
      ticketNumber: ocr.ticketNumber || '',
      purchaseDate: ocr.purchaseDate || '',
      purchaseDateTime: ocr.purchaseDateTime,
      totalCents: ocr.totalCents || 0,
      currency: /^[A-Z]{3}$/.test(ocr.currency || '') ? ocr.currency! : 'EUR',
    };
    const fingerprint = ocr.isReceipt ? buildTicketFingerprint(fields) : null;
    if (ocrResult.verificationIssues.length > 0) {
      const reasons = [
        'OCR_VERIFICATION_REQUIRED',
        ...ocrResult.verificationIssues.map((issue) => `OCR_${issue}`),
      ];
      await client.query(
        `UPDATE receipts SET status = 'REWARD_FAILED', store_id = $2, store_name = $3,
           ticket_number = $4, purchase_date = $5, total_cents = $6, currency = $7,
           ticket_fingerprint = NULL, ocr_payload = $8::jsonb, ocr_confidence = $9,
           ocr_provider = $10, ocr_model = $11, ocr_attempt_count = $12,
           ocr_duration_ms = $13, ocr_completed_at = NOW(), ocr_last_error = NULL, risk_score = 0,
           validation_reasons = $14::jsonb, review_status = 'PENDING',
           reviewed_at = NULL, reviewed_by = NULL, updated_at = NOW()
         WHERE id = $1`,
        [receiptId, selectedStore?.id || null, fields.storeName || null,
          fields.ticketNumber || null, fields.purchaseDate || null, fields.totalCents || null,
          fields.currency, JSON.stringify(ocr), ocr.confidence, ocrResult.provider,
          ocrResult.model, ocrResult.attemptCount, ocrResult.durationMs, JSON.stringify(reasons)],
      );
      return;
    }
    const duplicate = fingerprint ? await client.query(
      `SELECT id FROM receipts
        WHERE user_ref = $1 AND ticket_fingerprint = $2 AND id <> $3
          AND status = ANY($4::text[])
        LIMIT 1`,
      [receipt.user_ref, fingerprint, receiptId, [...ACTIVE_DUPLICATE_STATUSES]],
    ) : null;
    const validation = validateReceiptAutomatically({
      fields,
      ocr,
      storeActive: selectedStore?.active === true,
      duplicate: Boolean(duplicate?.rowCount),
      allowedPurchaseStart: appSettings['validation.startAt'],
      allowedPurchaseEnd: appSettings['validation.endAt'],
    });
    const status = receiptStatusAfterOcr(validation);
    completedStatus = status;
    let points = 0;
    if (status === 'REWARD_PENDING') {
      const tiers = await client.query<{ id: string; minimum_cents: number; points: number; active: boolean }>(
        'SELECT id, minimum_cents, points, active FROM reward_tiers WHERE active = TRUE',
      );
      points = resolveRewardPoints(
        fields.totalCents,
        tiers.rows.map((tier) => ({
          id: tier.id,
          minimumCents: tier.minimum_cents,
          points: tier.points,
          active: tier.active,
        })),
      );
      rewardOutboxId = uuid();
    }
    await client.query(
      `UPDATE receipts SET status = $2, store_id = $3, store_name = $4,
         ticket_number = $5, purchase_date = $6, total_cents = $7, currency = $8,
         ticket_fingerprint = $9, ocr_payload = $10::jsonb, ocr_confidence = $11,
         risk_score = $12, validation_reasons = $13::jsonb,
         ocr_provider = $14, ocr_model = $15, ocr_attempt_count = $16,
         ocr_duration_ms = $17, ocr_completed_at = NOW(), ocr_last_error = NULL,
         points_awarded = $18,
         review_status = 'CLEARED', reviewed_at = NOW(), reviewed_by = 'SYSTEM',
         updated_at = NOW()
       WHERE id = $1`,
      [receiptId, status, selectedStore?.id || null, fields.storeName || null,
        fields.ticketNumber || null, fields.purchaseDate || null, fields.totalCents || null,
        fields.currency, status === 'DUPLICATE' ? null : fingerprint,
        JSON.stringify(ocr), ocr.confidence, validation.riskScore,
        JSON.stringify(validation.reasons), ocrResult.provider, ocrResult.model,
        ocrResult.attemptCount, ocrResult.durationMs, points],
    );
    if (rewardOutboxId) {
      await client.query(
        `INSERT INTO reward_outbox
           (id, receipt_id, operation, idempotency_key, payload)
         VALUES ($1, $2, 'GRANT', $3, $4::jsonb)`,
        [rewardOutboxId, receiptId, rewardIdempotencyKey(receiptId), JSON.stringify({
          points,
          automatic: true,
        })],
      );
    }
  });
  if (completedStatus === 'NOT_A_RECEIPT') {
    await withDatabase(env, (client) => inTransaction(client, async () => {
      await recordUserOffense(client, receipt, 'NOT_A_RECEIPT', 'AUTOMATIC', 'SYSTEM');
    }));
  } else if (completedStatus) {
    await withDatabase(env, (client) => inTransaction(client, async () => {
      await clearAutomaticNonTicketOffense(client, receipt.id, receipt.external_user_id);
    }));
  }
  await enqueueRewardOutbox(env, receiptId, rewardOutboxId);
}

async function recordOcrFailure(env: Env, receiptId: string, lastError: string): Promise<void> {
  await withDatabase(env, async (client) => {
    await client.query(
      `UPDATE receipts SET ocr_last_error = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'OCR_PROCESSING'`,
      [receiptId, lastError],
    );
  });
}

async function markOcrFailed(env: Env, receiptId: string, reason: string, lastError: string): Promise<void> {
  const reasons = reason === 'OCR_PROCESSING_FAILED'
    ? ['OCR_PROCESSING_FAILED']
    : [reason, 'OCR_PROCESSING_FAILED'];
  await withDatabase(env, async (client) => {
    await client.query(
      `UPDATE receipts SET status = 'REWARD_FAILED', validation_reasons = $2::jsonb,
          review_status = 'PENDING', reviewed_at = NULL, reviewed_by = NULL,
          ocr_last_error = $3, ocr_completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'OCR_PROCESSING'`,
      [receiptId, JSON.stringify(reasons), lastError],
    );
  });
}

async function purgeReceipt(env: Env, receiptId: string, managerEmail: string): Promise<boolean> {
  const receipt = await withDatabase(env, async (client) => {
    const result = await client.query<ReceiptRow>('SELECT * FROM receipts WHERE id = $1 LIMIT 1', [receiptId]);
    return result.rows[0] || null;
  });
  if (!receipt) return false;
  await env.TICKETS.delete(receipt.image_key);
  await withDatabase(env, (client) => inTransaction(client, async () => {
    await client.query(
      `INSERT INTO receipt_deletion_audit (id, receipt_id, public_id, manager_email, snapshot)
       VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT(receipt_id) DO NOTHING`,
      [uuid(), receipt.id, receipt.public_id, managerEmail, JSON.stringify({
        userRef: receipt.user_ref, lookupCode: receipt.rtales_lookup_code_snapshot,
        status: receipt.status, storeId: receipt.store_id, storeName: receipt.store_name,
        ticketNumber: receipt.ticket_number, purchaseDate: receipt.purchase_date,
        totalCents: receipt.total_cents, pointsAwarded: receipt.points_awarded,
        resultId: receipt.rtales_result_id, reversalId: receipt.rtales_reversal_id,
        createdAt: receipt.created_at,
      })],
    );
    await client.query('DELETE FROM receipt_reviews WHERE receipt_id = $1', [receiptId]);
    await client.query('DELETE FROM reward_outbox WHERE receipt_id = $1', [receiptId]);
    await client.query('DELETE FROM receipts WHERE id = $1', [receiptId]);
  }));
  return true;
}

async function markOutboxTerminalFailure(env: Env, outboxId: string, failure: string): Promise<void> {
  await withDatabase(env, async (client) => inTransaction(client, async () => {
    const failed = await client.query<{ receipt_id: string; operation: 'GRANT' | 'REVOKE' }>(
      `UPDATE reward_outbox SET status = 'FAILED', last_error = $2,
         locked_until = NULL, updated_at = NOW()
       WHERE id = $1 AND status IN ('PENDING', 'PROCESSING')
       RETURNING receipt_id, operation`,
      [outboxId, failure.slice(0, 500)],
    );
    const outbox = failed.rows[0];
    if (!outbox) return;
    if (outbox.operation === 'GRANT') {
      await client.query(
        `UPDATE receipts SET status = 'REWARD_FAILED',
           validation_reasons = $2::jsonb, review_status = 'CLEARED',
           reviewed_at = NOW(), reviewed_by = 'SYSTEM', updated_at = NOW()
         WHERE id = $1 AND status = 'REWARD_PENDING'`,
        [outbox.receipt_id, JSON.stringify(['RTALES_DELIVERY_FAILED'])],
      );
    } else {
      await client.query(
        `UPDATE receipts SET status = 'REWARDED', updated_at = NOW()
         WHERE id = $1 AND status = 'REVOKE_PENDING'`,
        [outbox.receipt_id],
      );
    }
  }));
}

async function scheduleOutboxRetry(
  env: Env,
  outboxId: string,
  attempt: number,
  failure: string,
  retryAfter = 0,
): Promise<number | null> {
  if (attempt >= rewardMaxAttempts(env)) {
    await markOutboxTerminalFailure(env, outboxId, failure);
    return null;
  }
  const delaySeconds = rewardRetryDelaySeconds(attempt, retryAfter);
  await withDatabase(env, (client) => client.query(
    `UPDATE reward_outbox SET status = 'PENDING', last_error = $2,
       next_attempt_at = $3, locked_until = NULL, updated_at = NOW()
     WHERE id = $1 AND status = 'PROCESSING'`,
    [outboxId, failure.slice(0, 500), databaseTimestampAfter(delaySeconds)],
  ).then(() => undefined));
  return delaySeconds;
}

async function processOutbox(env: Env, outboxId: string): Promise<number | null> {
  const maxAttempts = rewardMaxAttempts(env);
  const claimed = await withDatabase(env, async (client) =>
    inTransaction(client, async () => {
      const result = await client.query<{
        id: string; receipt_id: string; operation: 'GRANT' | 'REVOKE';
        idempotency_key: string; payload: Record<string, unknown>; attempt_count: number;
      }>(
        `UPDATE reward_outbox SET status = 'PROCESSING', attempt_count = attempt_count + 1,
           locked_until = NOW() + INTERVAL '45 seconds', updated_at = NOW()
         WHERE id = $1 AND next_attempt_at <= NOW() AND attempt_count < $2
           AND (status = 'PENDING' OR (status = 'PROCESSING' AND locked_until < NOW()))
         RETURNING id, receipt_id, operation, idempotency_key, payload, attempt_count`,
        [outboxId, maxAttempts],
      );
      const row = result.rows[0];
      if (!row) return null;
      const receipt = await client.query<ReceiptRow & SessionRow>(
        `SELECT r.*, s.rtales_game_session_id, s.player_token_encrypted,
                s.parent_origin, s.display_name
           FROM receipts r JOIN player_sessions s ON s.id = r.session_id
          WHERE r.id = $1`,
        [row.receipt_id],
      );
      return { outbox: row, receipt: receipt.rows[0] };
    }),
  );
  if (!claimed?.receipt) return null;

  const { outbox, receipt } = claimed;
  let delivery: Awaited<ReturnType<typeof grantTicketPoints>>;
  try {
    delivery = outbox.operation === 'GRANT'
      ? await grantTicketPoints(env, {
          gameSessionId: receipt.rtales_game_session_id,
          playerToken: await decryptSecret(receipt.player_token_encrypted, env.DATA_ENCRYPTION_KEY),
          receiptId: receipt.id,
          publicId: receipt.public_id,
          points: receipt.points_awarded,
          totalCents: receipt.total_cents || 0,
          idempotencyKey: outbox.idempotency_key,
        })
      : await revokeTicketPoints(env, {
          resultId: receipt.rtales_result_id || '',
          receiptId: receipt.id,
          reason: String(outbox.payload.reason || 'Fraude detectado'),
          managerEmail: String(outbox.payload.managerEmail || ''),
          idempotencyKey: outbox.idempotency_key,
        });
  } catch (caught) {
    const failure = caught instanceof RtalesTransportError ? caught.code : 'RTALES_NETWORK_ERROR';
    return scheduleOutboxRetry(env, outboxId, outbox.attempt_count, failure);
  }

  if (!delivery.response.ok || !delivery.payload.success) {
    const retryable = delivery.response.status >= 500 || [408, 425, 429].includes(delivery.response.status);
    const failure = String(delivery.payload.error || `HTTP_${delivery.response.status}`);
    if (retryable) {
      return scheduleOutboxRetry(
        env,
        outboxId,
        outbox.attempt_count,
        failure,
        delivery.response.status === 429 ? retryAfterSeconds(delivery.response) : 0,
      );
    }
    await markOutboxTerminalFailure(env, outboxId, failure);
    return null;
  }

  const resultPayload = (delivery.payload.result || delivery.payload.reversal) as Record<string, unknown> | undefined;
  await withDatabase(env, async (client) => inTransaction(client, async () => {
    await client.query(
      `UPDATE reward_outbox SET status = 'DELIVERED', response_payload = $2::jsonb,
         locked_until = NULL, last_error = NULL, updated_at = NOW() WHERE id = $1`,
      [outboxId, JSON.stringify(delivery.payload)],
    );
    if (outbox.operation === 'GRANT') {
      await client.query(
        `UPDATE receipts SET status = 'REWARDED', rtales_result_id = $2,
           rewarded_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [receipt.id, String(resultPayload?.id || '')],
      );
    } else {
      await client.query(
        `UPDATE receipts SET status = 'REVOKED', rtales_reversal_id = $2,
           revoked_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [receipt.id, String(resultPayload?.id || '')],
      );
    }
  }));
  if (outbox.operation === 'REVOKE' && receipt.deletion_requested_at) {
    await purgeReceipt(env, receipt.id, receipt.deletion_requested_by || 'SYSTEM');
  }
  return null;
}

function adminFilters(url: URL) {
  const values: unknown[] = [];
  const conditions: string[] = ['1 = 1'];
  let lookupOrderPlaceholder = '';
  const add = (sql: string, value: unknown) => {
    values.push(value);
    conditions.push(sql.replace('?', `$${values.length}`));
  };
  if (url.searchParams.get('user')) {
    const search = String(url.searchParams.get('user') || '').trim();
    const normalizedLookup = normalizeLookupCode(search);
    values.push(normalizedLookup);
    const exactLookupPlaceholder = `$${values.length}`;
    values.push(`%${search}%`);
    const displayNamePlaceholder = `$${values.length}`;
    conditions.push(`(u.rtales_lookup_code_normalized = ${exactLookupPlaceholder}
      OR s.display_name ILIKE ${displayNamePlaceholder})`);
    lookupOrderPlaceholder = exactLookupPlaceholder;
  }
  if (url.searchParams.get('space')) {
    const space = String(url.searchParams.get('space') || '').trim();
    values.push(space);
    const installationPlaceholder = `$${values.length}`;
    values.push(space.toUpperCase());
    const spaceCodePlaceholder = `$${values.length}`;
    conditions.push(`(u.installation_id = ${installationPlaceholder} OR u.space_code = ${spaceCodePlaceholder})`);
  }
  if (url.searchParams.get('store')) {
    const value = `%${url.searchParams.get('store')}%`;
    values.push(value);
    const linkedStorePlaceholder = `$${values.length}`;
    values.push(value);
    const ocrStorePlaceholder = `$${values.length}`;
    conditions.push(`(r.store_name ILIKE ${linkedStorePlaceholder} OR json_extract(r.ocr_payload, '$.storeName') ILIKE ${ocrStorePlaceholder})`);
  }
  if (url.searchParams.get('status')) add('r.status = ?', url.searchParams.get('status'));
  if (url.searchParams.get('review')) add('r.review_status = ?', url.searchParams.get('review'));
  if (url.searchParams.get('from')) add('r.purchase_date >= ?', url.searchParams.get('from'));
  if (url.searchParams.get('to')) add('r.purchase_date <= ?', url.searchParams.get('to'));
  if (url.searchParams.get('attention') === '1') {
    conditions.push(`r.status IN ('AUTO_REJECTED', 'NOT_A_RECEIPT', 'REWARD_FAILED', 'REVOKE_PENDING', 'REVOKED', 'DUPLICATE')`);
  }
  return {
    where: conditions.join(' AND '),
    values,
    orderBy: lookupOrderPlaceholder
      ? `CASE WHEN u.rtales_lookup_code_normalized = ${lookupOrderPlaceholder} THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC`
      : 'r.created_at DESC, r.id DESC',
  };
}

async function adminRows(env: Env, url: URL, pagination?: { limit: number; offset: number }): Promise<ReceiptRow[]> {
  const filters = adminFilters(url);
  const pageClause = pagination ? ` LIMIT ${pagination.limit} OFFSET ${pagination.offset}` : '';
  return withDatabase(env, async (client) => {
    const result = await client.query<ReceiptRow>(
      `SELECT r.*, COALESCE(u.display_name, s.display_name) AS user_display_name,
              COALESCE(u.email, s.user_email) AS user_email,
              COALESCE(u.rtales_lookup_code, r.rtales_lookup_code_snapshot, s.rtales_lookup_code) AS user_lookup_code,
              COALESCE(u.space_code, s.space_code) AS user_space_code,
              COALESCE(u.installation_id, s.installation_id) AS user_installation_id
         FROM receipts r JOIN player_sessions s ON s.id = r.session_id
         LEFT JOIN external_users u ON u.id = COALESCE(r.external_user_id, s.external_user_id)
        WHERE ${filters.where}
        ORDER BY ${filters.orderBy}${pageClause}`,
      filters.values,
    );
    return result.rows;
  });
}

async function adminRowCount(env: Env, url: URL): Promise<number> {
  const filters = adminFilters(url);
  return withDatabase(env, async (client) => {
    const result = await client.query<{ total: number }>(
      `SELECT COUNT(*) AS total
         FROM receipts r JOIN player_sessions s ON s.id = r.session_id
         LEFT JOIN external_users u ON u.id = COALESCE(r.external_user_id, s.external_user_id)
        WHERE ${filters.where}`,
      filters.values,
    );
    return Number(result.rows[0]?.total || 0);
  });
}

async function handleAdminList(request: Request, env: Env): Promise<Response> {
  const manager = managerIdentity(request, env);
  if (!manager) return error('Acceso de gestor requerido', 401);
  const url = new URL(request.url);
  const requestedPage = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const pageSize = 50;
  const total = await adminRowCount(env, url);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const rows = await adminRows(env, url, { limit: pageSize, offset: (page - 1) * pageSize });
  return json({
    success: true,
    manager,
    receipts: rows.map((row) => receiptView(row, true)),
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
    },
  });
}

async function handleAdminReceipt(request: Request, env: Env, receiptId: string): Promise<Response> {
  const manager = managerIdentity(request, env);
  if (!manager) return error('Acceso de gestor requerido', 401);
  const receipt = await withDatabase(env, async (client) => {
    const result = await client.query<ReceiptRow>(
      `SELECT r.*, COALESCE(u.display_name, s.display_name) AS user_display_name,
              COALESCE(u.email, s.user_email) AS user_email,
              COALESCE(u.rtales_lookup_code, r.rtales_lookup_code_snapshot, s.rtales_lookup_code) AS user_lookup_code,
              COALESCE(u.space_code, s.space_code) AS user_space_code,
              COALESCE(u.installation_id, s.installation_id) AS user_installation_id
         FROM receipts r JOIN player_sessions s ON s.id = r.session_id
         LEFT JOIN external_users u ON u.id = COALESCE(r.external_user_id, s.external_user_id)
        WHERE r.id = $1 LIMIT 1`,
      [receiptId],
    );
    return result.rows[0];
  });
  if (!receipt) return error('Ticket no encontrado', 404);
  return json({ success: true, manager, receipt: receiptView(receipt, true) });
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

async function handleAdminCsv(request: Request, env: Env): Promise<Response> {
  if (!managerIdentity(request, env)) return error('Acceso de gestor requerido', 401);
  const rows = await adminRows(env, new URL(request.url));
  const header = ['ID', 'Usuario', 'Código búsqueda', 'Correo', 'Subject Rtales', 'Espacio', 'Instalación', 'Estado', 'Revisión', 'Tienda', 'Número', 'Fecha compra', 'Importe', 'Moneda', 'Puntos', 'Riesgo', 'Creado'];
  const lines = rows.map((row) => [row.public_id, row.user_display_name, row.user_lookup_code, row.user_email,
    row.user_ref, row.user_space_code, row.user_installation_id, row.status, row.review_status, row.store_name,
    row.ticket_number, row.purchase_date, row.total_cents, row.currency,
    row.points_awarded, row.risk_score, row.created_at].map(csvCell).join(','));
  return new Response(`\uFEFF${header.map(csvCell).join(',')}\n${lines.join('\n')}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="tickets-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

async function handleAdminImage(request: Request, env: Env, receiptId: string): Promise<Response> {
  if (!managerIdentity(request, env)) return error('Acceso de gestor requerido', 401);
  const receipt = await withDatabase(env, async (client) => {
    const result = await client.query<Pick<ReceiptRow, 'image_key' | 'image_content_type'>>(
      'SELECT image_key, image_content_type FROM receipts WHERE id = $1 LIMIT 1',
      [receiptId],
    );
    return result.rows[0];
  });
  if (!receipt) return error('Ticket no encontrado', 404);
  const object = await env.TICKETS.get(receipt.image_key);
  if (!object) return error('Imagen no encontrada', 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': receipt.image_content_type,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline',
    },
  });
}

async function handleAdminReprocess(request: Request, env: Env, receiptId: string): Promise<Response> {
  if (!managerIdentity(request, env)) return error('Acceso de gestor requerido', 401);
  const receipt = await withDatabase(env, async (client) => {
    const result = await client.query<ReceiptRow>(
      'SELECT * FROM receipts WHERE id = $1 LIMIT 1',
      [receiptId],
    );
    return result.rows[0];
  });
  if (!receipt) return error('Ticket no encontrado', 404);
  if (!canReprocessReceipt(receipt.status, receipt.validation_reasons)) {
    return error('Este ticket no se puede volver a comprobar en su estado actual', 409);
  }

  const queued = await withDatabase(env, async (client) => client.query(
    `UPDATE receipts SET status = 'OCR_QUEUED', ticket_fingerprint = NULL,
        validation_reasons = $3::jsonb, review_status = 'PENDING',
        reviewed_at = NULL, reviewed_by = NULL, ocr_last_error = NULL,
        ocr_job_attempt_count = 0, updated_at = NOW()
      WHERE id = $1 AND status = $2`,
    [receiptId, receipt.status, JSON.stringify(['OCR_REPROCESS_REQUESTED'])],
  ));
  if (!queued.rowCount) return error('El ticket ha cambiado de estado; actualiza la ficha', 409);

  try {
    await env.OCR_JOBS.send({ kind: 'OCR_RECEIPT', receiptId });
  } catch (caught) {
    await withDatabase(env, async (client) => {
      await client.query(
        `UPDATE receipts SET status = $2, ticket_fingerprint = $3,
            validation_reasons = $4::jsonb, review_status = $5,
            reviewed_at = $6, reviewed_by = $7, ocr_last_error = $8,
            ocr_job_attempt_count = $9, updated_at = NOW()
          WHERE id = $1 AND status = 'OCR_QUEUED'`,
        [receiptId, receipt.status, receipt.ticket_fingerprint,
          JSON.stringify(receipt.validation_reasons), receipt.review_status,
          receipt.reviewed_at, receipt.reviewed_by, receipt.ocr_last_error,
          receipt.ocr_job_attempt_count],
      );
    });
    throw caught;
  }
  return json({ success: true, status: 'OCR_QUEUED' }, 202);
}

async function handleAdminReceiptDelete(request: Request, env: Env, receiptId: string): Promise<Response> {
  const managerEmail = managerIdentity(request, env);
  if (!managerEmail) return error('Acceso de gestor requerido', 401);
  let outboxId = '';
  const decision = await withDatabase(env, (client) => inTransaction(client, async () => {
    const result = await client.query<ReceiptRow>('SELECT * FROM receipts WHERE id = $1 FOR UPDATE', [receiptId]);
    const receipt = result.rows[0];
    if (!receipt) return 'NOT_FOUND';

    const activeGrant = await client.query<{ status: string }>(
      `SELECT status FROM reward_outbox WHERE receipt_id = $1 AND operation = 'GRANT'
       AND status IN ('PENDING', 'PROCESSING') LIMIT 1`, [receiptId],
    );
    if (activeGrant.rows[0]?.status === 'PROCESSING') return 'BUSY';
    if (activeGrant.rows[0]?.status === 'PENDING') {
      await client.query("DELETE FROM reward_outbox WHERE receipt_id = $1 AND operation = 'GRANT' AND status = 'PENDING'", [receiptId]);
    }

    if (receipt.rtales_result_id && receipt.status !== 'REVOKED') {
      await client.query(
        `UPDATE receipts SET status = 'REVOKE_PENDING', deletion_requested_at = NOW(),
          deletion_requested_by = $2, updated_at = NOW() WHERE id = $1`,
        [receiptId, managerEmail],
      );
      const existing = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM reward_outbox WHERE receipt_id = $1 AND operation = 'REVOKE'
         ORDER BY created_at DESC LIMIT 1`, [receiptId],
      );
      if (existing.rows[0]?.status === 'DELIVERED') return 'PURGE';
      outboxId = existing.rows[0]?.id || uuid();
      if (existing.rows[0]?.status === 'FAILED') {
        await client.query(
          `UPDATE reward_outbox SET status = 'PENDING', attempt_count = 0, last_error = NULL,
             next_attempt_at = NOW(), locked_until = NULL, payload = $2::jsonb, updated_at = NOW()
           WHERE id = $1`,
          [outboxId, JSON.stringify({
            reason: 'Ticket eliminado por un administrador', managerEmail, deleteAfterReversal: true,
          })],
        );
      } else if (!existing.rows[0]) {
        await client.query(
          `INSERT INTO reward_outbox (id, receipt_id, operation, idempotency_key, payload)
           VALUES ($1, $2, 'REVOKE', $3, $4::jsonb)`,
          [outboxId, receiptId, reversalIdempotencyKey(receiptId), JSON.stringify({
            reason: 'Ticket eliminado por un administrador', managerEmail, deleteAfterReversal: true,
          })],
        );
      }
      return 'REVOKE';
    }
    return 'PURGE';
  }));
  if (decision === 'NOT_FOUND') return error('Ticket no encontrado', 404);
  if (decision === 'BUSY') return error('La concesión está procesándose; vuelve a intentarlo en unos segundos', 409);
  if (decision === 'REVOKE') {
    await env.REWARD_JOBS.send({ kind: 'DELIVER_REWARD', outboxId });
    return json({ success: true, pendingReversal: true }, 202);
  }
  await purgeReceipt(env, receiptId, managerEmail);
  return json({ success: true, deleted: true });
}

async function handleAdminReview(
  request: Request,
  env: Env,
  receiptId: string,
): Promise<Response> {
  const managerEmail = managerIdentity(request, env);
  if (!managerEmail) return error('Acceso de gestor requerido', 401);
  const body = await readJson(request);
  const action = String(body.action || '').toUpperCase();
  const reason = String(body.reason || '').trim().slice(0, 500);
  if (!['CLEAR', 'REOPEN', 'REVOKE', 'MANUAL_APPROVE', 'CONFIRM_REJECTION', 'CONFIRM_FRAUD'].includes(action)) return error('Acción no válida', 400);
  let outboxId = '';
  const response = await withDatabase(env, (client) => inTransaction(client, async () => {
    const result = await client.query<ReceiptRow>('SELECT * FROM receipts WHERE id = $1 FOR UPDATE', [receiptId]);
    const receipt = result.rows[0];
    if (!receipt) return error('Ticket no encontrado', 404);
    if (action === 'CONFIRM_FRAUD') {
      const eligible = receipt.status === 'AUTO_REJECTED' ||
        (receipt.status === 'REWARD_FAILED' && !receipt.rtales_result_id);
      if (!eligible) return error('Este ticket no admite marcarse como fraude sin revocación', 409);
      if (!reason) return error('Indica el motivo del fraude', 400);
      await client.query(
        `INSERT INTO receipt_reviews (id, receipt_id, action, manager_email, reason)
         VALUES ($1, $2, 'FRAUD_CONFIRMED', $3, $4)`,
        [uuid(), receiptId, managerEmail, reason],
      );
      await client.query(
        `UPDATE receipts SET review_status = 'FRAUD', reviewed_at = NOW(),
           reviewed_by = $2, updated_at = NOW() WHERE id = $1`,
        [receiptId, managerEmail],
      );
      await recordUserOffense(client, receipt, 'CONFIRMED_FRAUD', 'ADMIN', managerEmail);
      return json({ success: true, status: receipt.status });
    }
    if (action === 'CONFIRM_REJECTION') {
      const verificationRequired = receipt.status === 'REWARD_FAILED' &&
        receipt.validation_reasons.includes('OCR_VERIFICATION_REQUIRED');
      if (receipt.status !== 'AUTO_REJECTED' && !verificationRequired) {
        return error('Este ticket no admite confirmar el rechazo', 409);
      }
      await client.query(
        `INSERT INTO receipt_reviews (id, receipt_id, action, manager_email, reason)
         VALUES ($1, $2, 'REJECTION_CONFIRMED', $3, $4)`,
        [uuid(), receiptId, managerEmail, reason || null],
      );
      await client.query(
        `UPDATE receipts SET review_status = 'CLEARED', reviewed_at = NOW(),
           reviewed_by = $2, updated_at = NOW() WHERE id = $1`,
        [receiptId, managerEmail],
      );
      return json({ success: true, status: receipt.status });
    }
    if (action === 'MANUAL_APPROVE') {
      const verificationRequired = receipt.status === 'REWARD_FAILED' &&
        receipt.validation_reasons.includes('OCR_VERIFICATION_REQUIRED');
      if (receipt.status !== 'AUTO_REJECTED' && !verificationRequired) {
        return error('Este ticket no admite validación manual', 409);
      }
      if (!reason) return error('Indica el motivo de la validación manual', 400);
      const corrections = body.fields && typeof body.fields === 'object'
        ? body.fields as Record<string, unknown>
        : {};
      const storeId = String(corrections.storeId || '').trim();
      const ticketNumber = String(corrections.ticketNumber || '').trim().slice(0, 120);
      const purchaseDate = String(corrections.purchaseDate || '').trim();
      const purchaseTime = String(corrections.purchaseTime || '').trim();
      const purchaseDateTime = purchaseTime ? `${purchaseDate}T${purchaseTime}` : undefined;
      const totalCents = Number(corrections.totalCents);
      const currency = String(corrections.currency || 'EUR').trim().toUpperCase();
      if (!storeId) return error('Selecciona un comercio autorizado', 400);
      if (!isValidIsoDate(purchaseDate)) return error('Indica una fecha válida', 400);
      if (!ticketNumber && !purchaseTime) return error('Indica el número del ticket o la hora de compra', 400);
      if (purchaseDateTime && !isValidPurchaseDateTime(purchaseDateTime, purchaseDate)) {
        return error('Indica una hora válida', 400);
      }
      if (!Number.isInteger(totalCents) || totalCents <= 0) return error('Indica un importe válido', 400);
      if (!/^[A-Z]{3}$/.test(currency)) return error('La moneda no es válida', 400);

      const storeResult = await client.query<StoreRow>(
        'SELECT * FROM stores WHERE id = $1 AND active = TRUE LIMIT 1', [storeId],
      );
      const store = storeResult.rows[0];
      if (!store) return error('El comercio seleccionado no está activo', 400);
      const fields: ReceiptFields = {
        storeId: store.id, storeName: store.name, ticketNumber, purchaseDate, purchaseDateTime, totalCents, currency,
      };
      const correctedOcr: OcrReceipt = {
        ...(receipt.ocr_payload || {}), ...fields, isReceipt: true,
        confidence: receipt.ocr_payload?.confidence ?? receipt.ocr_confidence ?? 0,
      };
      const fingerprint = buildTicketFingerprint(fields);
      const duplicate = await client.query(
        `SELECT id FROM receipts
          WHERE user_ref = $1 AND ticket_fingerprint = $2 AND id <> $3
            AND status = ANY($4::text[]) LIMIT 1`,
        [receipt.user_ref, fingerprint, receiptId, [...ACTIVE_DUPLICATE_STATUSES]],
      );
      if (duplicate.rowCount) return error('Este ticket ya había sido utilizado', 409);
      const tiers = await client.query<{ id: string; minimum_cents: number; points: number; active: boolean }>(
        'SELECT id, minimum_cents, points, active FROM reward_tiers WHERE active = TRUE',
      );
      const points = resolveRewardPoints(totalCents, tiers.rows.map((tier) => ({
        id: tier.id, minimumCents: tier.minimum_cents, points: tier.points, active: tier.active,
      })));
      outboxId = uuid();
      await client.query(
        `INSERT INTO receipt_reviews (id, receipt_id, action, manager_email, reason, changes)
         VALUES ($1, $2, 'MANUALLY_APPROVED', $3, $4, $5::jsonb)`,
        [uuid(), receiptId, managerEmail, reason, JSON.stringify({
          previous: { storeId: receipt.store_id, storeName: receipt.store_name,
            ticketNumber: receipt.ticket_number, purchaseDate: receipt.purchase_date,
            totalCents: receipt.total_cents, currency: receipt.currency,
            reasons: receipt.validation_reasons },
          corrected: fields,
        })],
      );
      await client.query(
        `UPDATE receipts SET status = 'REWARD_PENDING', store_id = $2, store_name = $3,
           ticket_number = $4, purchase_date = $5, total_cents = $6, currency = $7,
           ticket_fingerprint = $8, ocr_payload = $9::jsonb, validation_reasons = '[]'::jsonb,
           points_awarded = $10, review_status = 'CLEARED', reviewed_at = NOW(),
           reviewed_by = $11, updated_at = NOW() WHERE id = $1`,
        [receiptId, store.id, store.name, ticketNumber, purchaseDate, totalCents,
          currency, fingerprint, JSON.stringify(correctedOcr), points, managerEmail],
      );
      await client.query(
        `INSERT INTO reward_outbox (id, receipt_id, operation, idempotency_key, payload)
         VALUES ($1, $2, 'GRANT', $3, $4::jsonb)`,
        [outboxId, receiptId, rewardIdempotencyKey(receiptId), JSON.stringify({
          points, manualApproval: true, managerEmail, reason,
        })],
      );
      return json({ success: true, status: 'REWARD_PENDING', points }, 202);
    }
    if (action === 'CLEAR') {
      if (receipt.review_status === 'CLEARED') {
        return json({ success: true, status: receipt.status, idempotent: true });
      }
      if (receipt.review_status === 'FRAUD' || receipt.status === 'REVOKED') {
        return error('Un ticket marcado como fraude no puede cerrarse como correcto', 409);
      }
      await client.query(
        `INSERT INTO receipt_reviews (id, receipt_id, action, manager_email, reason)
         VALUES ($1, $2, 'REVIEWED_NO_FRAUD', $3, $4)`,
        [uuid(), receiptId, managerEmail, reason || null],
      );
      await client.query(
        `UPDATE receipts SET review_status = 'CLEARED', reviewed_at = NOW(),
           reviewed_by = $2, updated_at = NOW() WHERE id = $1`,
        [receiptId, managerEmail],
      );
      return json({ success: true, status: receipt.status });
    }
    if (action === 'REOPEN') {
      if (receipt.review_status === 'PENDING') {
        return json({ success: true, status: receipt.status, idempotent: true });
      }
      if (receipt.review_status === 'FRAUD' || ['REVOKE_PENDING', 'REVOKED'].includes(receipt.status)) {
        return error('Un ticket marcado como fraude no puede volver a pendientes', 409);
      }
      await client.query(
        `INSERT INTO receipt_reviews (id, receipt_id, action, manager_email, reason)
         VALUES ($1, $2, 'REVIEW_REOPENED', $3, $4)`,
        [uuid(), receiptId, managerEmail, reason || 'Revisión reabierta'],
      );
      await client.query(
        `UPDATE receipts SET review_status = 'PENDING', reviewed_at = NULL,
           reviewed_by = NULL, updated_at = NOW() WHERE id = $1`,
        [receiptId],
      );
      return json({ success: true, status: receipt.status });
    }
    if (receipt.status !== 'REWARDED' || !receipt.rtales_result_id) {
      return error('Solo se puede revocar un ticket premiado', 409);
    }
    outboxId = uuid();
    await client.query(
      `INSERT INTO receipt_reviews (id, receipt_id, action, manager_email, reason)
       VALUES ($1, $2, 'FRAUD_REVOKED', $3, $4)`,
      [uuid(), receiptId, managerEmail, reason || 'Fraude detectado'],
    );
    await client.query(
      `UPDATE receipts SET status = 'REVOKE_PENDING', review_status = 'FRAUD',
         reviewed_at = NOW(), reviewed_by = $2, updated_at = NOW() WHERE id = $1`,
      [receiptId, managerEmail],
    );
    await client.query(
      `INSERT INTO reward_outbox (id, receipt_id, operation, idempotency_key, payload)
       VALUES ($1, $2, 'REVOKE', $3, $4::jsonb)`,
      [outboxId, receiptId, reversalIdempotencyKey(receiptId),
        JSON.stringify({ reason: reason || 'Fraude detectado', managerEmail })],
    );
    await recordUserOffense(client, receipt, 'CONFIRMED_FRAUD', 'ADMIN', managerEmail);
    return json({ success: true, status: 'REVOKE_PENDING' }, 202);
  }));
  if (outboxId) await env.REWARD_JOBS.send({ kind: 'DELIVER_REWARD', outboxId });
  return response;
}

function storeView(row: StoreRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    active: row.active,
    ocrProfile: normalizeStoreOcrProfile(row.ocr_profile),
    logoUrl: row.logo_key
      ? `/api/admin/stores/${row.id}/logo?v=${encodeURIComponent(row.logo_updated_at || row.logo_key)}`
      : '',
    logoWidth: Number(row.logo_width || 0),
    logoHeight: Number(row.logo_height || 0),
    receiptCount: Number(row.receipt_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storeIdentity(row: StoreRow) {
  return {
    ...row,
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    ocrProfile: normalizeStoreOcrProfile(row.ocr_profile),
  };
}

async function handleStoreLogo(
  request: Request,
  env: Env,
  storeId: string,
  admin: boolean,
): Promise<Response> {
  if (admin && !managerIdentity(request, env)) return error('Acceso de gestor requerido', 401);
  const store = await withDatabase(env, async (client) => {
    const result = await client.query<Pick<StoreRow, 'active' | 'logo_key' | 'logo_content_type'>>(
      'SELECT active, logo_key, logo_content_type FROM stores WHERE id = $1 LIMIT 1',
      [storeId],
    );
    return result.rows[0];
  });
  if (!store || (!admin && !store.active) || !store.logo_key) return error('Logo no encontrado', 404);
  const object = await env.TICKETS.get(store.logo_key);
  if (!object) return error('Logo no encontrado', 404);
  const headers = new Headers({
    'Content-Type': store.logo_content_type || object.httpMetadata?.contentType || 'image/webp',
    'Cache-Control': admin ? 'private, no-store' : 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  });
  headers.set('ETag', object.httpEtag);
  if (request.headers.get('If-None-Match') === object.httpEtag) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
}

async function handleAdminStoreLogoUpload(
  request: Request,
  env: Env,
  storeId: string,
): Promise<Response> {
  const managerEmail = managerIdentity(request, env);
  if (!managerEmail) return error('Acceso de gestor requerido', 401);
  const current = await withDatabase(env, async (client) => {
    const result = await client.query<StoreRow>('SELECT * FROM stores WHERE id = $1 LIMIT 1', [storeId]);
    return result.rows[0];
  });
  if (!current) return error('Comercio no encontrado', 404);

  const form = await request.formData();
  const logo = form.get('logo');
  if (!(logo instanceof File)) return error('Selecciona una imagen para el comercio', 400);
  if (!new Set(['image/jpeg', 'image/png', 'image/webp']).has(logo.type)) {
    return error('Formato de imagen no admitido', 415);
  }
  if (logo.size <= 0 || logo.size > 5 * 1024 * 1024) return error('El logo supera el límite de 5 MB', 413);

  const optimized = await optimizeStoreLogo(env, await logo.arrayBuffer());
  const objectKey = `store-logos/${storeId}/${uuid()}.${optimized.extension}`;
  await env.TICKETS.put(objectKey, optimized.bytes, {
    httpMetadata: { contentType: optimized.contentType },
    customMetadata: {
      storeId,
      originalBytes: String(optimized.originalBytes),
      storedBytes: String(optimized.bytes.byteLength),
      storedDimensions: `${optimized.width}x${optimized.height}`,
    },
  });

  let updated: StoreRow;
  try {
    updated = await withDatabase(env, (client) => inTransaction(client, async () => {
      const result = await client.query<StoreRow>(
        `UPDATE stores SET logo_key = $2, logo_content_type = $3,
           logo_width = $4, logo_height = $5, logo_size = $6,
           logo_updated_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [storeId, objectKey, optimized.contentType, optimized.width, optimized.height, optimized.bytes.byteLength],
      );
      await client.query(
        `INSERT INTO store_audit_log (id, store_id, action, manager_email, changes)
         VALUES ($1, $2, 'UPDATED', $3, $4::jsonb)`,
        [uuid(), storeId, managerEmail, JSON.stringify({ logo: {
          width: optimized.width,
          height: optimized.height,
          bytes: optimized.bytes.byteLength,
        } })],
      );
      return result.rows[0]!;
    }));
  } catch (caught) {
    try {
      await env.TICKETS.delete(objectKey);
    } catch (cleanupError) {
      console.error('Could not clean up unlinked store logo', cleanupError);
    }
    throw caught;
  }
  if (current.logo_key && current.logo_key !== objectKey) {
    try {
      await env.TICKETS.delete(current.logo_key);
    } catch (cleanupError) {
      console.error('Could not remove previous store logo', cleanupError);
    }
  }
  return json({ success: true, store: storeView(updated) });
}

async function handleAdminStores(request: Request, env: Env): Promise<Response> {
  const managerEmail = managerIdentity(request, env);
  if (!managerEmail) return error('Acceso de gestor requerido', 401);

  if (request.method === 'GET') {
    const rows = await withDatabase(env, async (client) => {
      const result = await client.query<StoreRow>(
        `SELECT s.*, COUNT(r.id)::text AS receipt_count
           FROM stores s LEFT JOIN receipts r ON r.store_id = s.id
          GROUP BY s.id ORDER BY s.active DESC, s.name ASC`,
      );
      return result.rows;
    });
    return json({ success: true, manager: managerEmail, stores: rows.map(storeView) });
  }

  const input = normalizeStoreInput(await readJson(request));
  const id = uuid();
  const created = await withDatabase(env, (client) => inTransaction(client, async () => {
    const duplicate = await client.query('SELECT id FROM stores WHERE code = $1 LIMIT 1', [input.code]);
    if (duplicate.rowCount) return null;
    const result = await client.query<StoreRow>(
      `INSERT INTO stores (id, code, name, aliases, active)
       VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *`,
      [id, input.code, input.name, JSON.stringify(input.aliases), input.active],
    );
    await client.query(
      `INSERT INTO store_audit_log (id, store_id, action, manager_email, changes)
       VALUES ($1, $2, 'CREATED', $3, $4::jsonb)`,
      [uuid(), id, managerEmail, JSON.stringify(input)],
    );
    return result.rows[0];
  }));
  if (!created) return error('Ya existe un comercio con ese código', 409);
  return json({ success: true, store: storeView(created) }, 201);
}

async function handleAdminStoreUpdate(
  request: Request,
  env: Env,
  storeId: string,
): Promise<Response> {
  const managerEmail = managerIdentity(request, env);
  if (!managerEmail) return error('Acceso de gestor requerido', 401);
  const input = normalizeStoreInput(await readJson(request));
  const updated = await withDatabase(env, (client) => inTransaction(client, async () => {
    const currentResult = await client.query<StoreRow>(
      'SELECT * FROM stores WHERE id = $1 FOR UPDATE',
      [storeId],
    );
    const current = currentResult.rows[0];
    if (!current) return { kind: 'missing' as const };
    const duplicate = await client.query(
      'SELECT id FROM stores WHERE code = $1 AND id <> $2 LIMIT 1',
      [input.code, storeId],
    );
    if (duplicate.rowCount) return { kind: 'duplicate' as const };
    const changes = {
      before: { code: current.code, name: current.name, aliases: current.aliases, active: current.active },
      after: input,
    };
    const action = current.active !== input.active
      ? (input.active ? 'ACTIVATED' : 'DEACTIVATED')
      : 'UPDATED';
    const result = await client.query<StoreRow>(
      `UPDATE stores SET code = $2, name = $3, aliases = $4::jsonb,
          active = $5, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [storeId, input.code, input.name, JSON.stringify(input.aliases), input.active],
    );
    await client.query(
      `INSERT INTO store_audit_log (id, store_id, action, manager_email, changes)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [uuid(), storeId, action, managerEmail, JSON.stringify(changes)],
    );
    return { kind: 'updated' as const, row: result.rows[0]! };
  }));
  if (updated.kind === 'missing') return error('Comercio no encontrado', 404);
  if (updated.kind === 'duplicate') return error('Ya existe un comercio con ese código', 409);
  return json({ success: true, store: storeView(updated.row) });
}

async function handleAdminStoreOcrProfile(
  request: Request,
  env: Env,
  storeId: string,
): Promise<Response> {
  const managerEmail = managerIdentity(request, env);
  if (!managerEmail) return error('Acceso de gestor requerido', 401);
  const current = await withDatabase(env, async (client) => {
    const result = await client.query<StoreRow>('SELECT * FROM stores WHERE id = $1 LIMIT 1', [storeId]);
    return result.rows[0];
  });
  if (!current) return error('Comercio no encontrado', 404);
  if (request.method === 'GET') {
    return json({ success: true, profile: normalizeStoreOcrProfile(current.ocr_profile) });
  }

  const profile = normalizeStoreOcrProfile(await readJson(request));
  if (profile.enabled && !(
    profile.headerSignatures.length || profile.ticketNumberLabels.length ||
    profile.dateLabels.length || profile.totalLabels.length || profile.instructions
  )) {
    return error('Añade alguna referencia antes de activar el perfil', 400);
  }
  const updated = await withDatabase(env, (client) => inTransaction(client, async () => {
    const result = await client.query<StoreRow>(
      `UPDATE stores SET ocr_profile = $2::jsonb, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [storeId, JSON.stringify(profile)],
    );
    await client.query(
      `INSERT INTO store_audit_log (id, store_id, action, manager_email, changes)
       VALUES ($1, $2, 'UPDATED', $3, $4::jsonb)`,
      [uuid(), storeId, managerEmail, JSON.stringify({ ocrProfile: profile })],
    );
    return result.rows[0]!;
  }));
  return json({ success: true, profile: normalizeStoreOcrProfile(updated.ocr_profile) });
}

async function handleAdminStoreOcrProfileGenerate(
  request: Request,
  env: Env,
  storeId: string,
): Promise<Response> {
  if (!managerIdentity(request, env)) return error('Acceso de gestor requerido', 401);
  const data = await withDatabase(env, async (client) => {
    const storeResult = await client.query<StoreRow>('SELECT * FROM stores WHERE id = $1 LIMIT 1', [storeId]);
    const sourceResult = await client.query<{
      notes: string;
      actual_payload: OcrReceipt | null;
      matches: TrainingEvaluationMatches | null;
    }>(
      `SELECT s.notes, e.actual_payload, e.matches
         FROM store_training_samples s
         LEFT JOIN store_training_evaluations e ON e.id = (
           SELECT latest.id FROM store_training_evaluations latest
            WHERE latest.sample_id = s.id ORDER BY latest.created_at DESC LIMIT 1
         )
        WHERE s.store_id = $1 ORDER BY s.created_at DESC`,
      [storeId],
    );
    return { store: storeResult.rows[0], sources: sourceResult.rows };
  });
  if (!data.store) return error('Comercio no encontrado', 404);
  const evaluated = data.sources.filter((source) => source.actual_payload);
  if (!evaluated.length) {
    return error('Evalúa al menos un ejemplo antes de generar el perfil', 409);
  }
  const profile = generateStoreOcrProfile(
    { name: data.store.name, aliases: data.store.aliases },
    evaluated.map((source) => ({
      receipt: source.actual_payload,
      matches: source.matches || {},
      notes: source.notes,
    })),
  );
  return json({ success: true, profile, evaluatedSamples: evaluated.length });
}

function trainingEvaluationView(row: TrainingEvaluationRow | null) {
  if (!row) return null;
  const matches = row.matches || {} as TrainingEvaluationMatches;
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    status: row.status,
    matches: { ...matches, purchaseTime: matches.purchaseTime ?? true },
    verificationIssues: Array.isArray(row.verification_issues) ? row.verification_issues : [],
    attemptCount: Number(row.attempt_count || 0),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
  };
}

function trainingSampleView(row: TrainingSampleRow) {
  const evaluation = row.evaluation_id ? trainingEvaluationView({
    id: row.evaluation_id,
    sample_id: row.id,
    provider: row.evaluation_provider || '',
    model: row.evaluation_model || '',
    status: row.evaluation_status || 'ERROR',
    actual_payload: null,
    matches: row.evaluation_matches || {} as TrainingEvaluationMatches,
    verification_issues: row.evaluation_verification_issues || [],
    attempt_count: Number(row.evaluation_attempt_count || 0),
    duration_ms: row.evaluation_duration_ms === null || row.evaluation_duration_ms === undefined
      ? null : Number(row.evaluation_duration_ms),
    error_message: row.evaluation_error_message || null,
    created_by: '',
    created_at: row.evaluation_created_at || '',
  }) : null;
  return {
    id: row.id,
    storeId: row.store_id,
    imageUrl: `/api/admin/stores/${row.store_id}/training/${row.id}/image`,
    image: {
      contentType: row.image_content_type,
      size: Number(row.image_size),
      width: Number(row.image_width),
      height: Number(row.image_height),
    },
    expected: {
      ticketNumber: row.expected_ticket_number,
      purchaseDate: String(row.expected_purchase_date).slice(0, 10),
      purchaseDateTime: row.expected_purchase_datetime || '',
      totalCents: Number(row.expected_total_cents),
      currency: row.expected_currency,
    },
    notes: row.notes || '',
    createdBy: row.created_by,
    createdAt: row.created_at,
    evaluation,
  };
}

async function loadTrainingSample(
  env: Env,
  storeId: string,
  sampleId: string,
): Promise<TrainingSampleRow | undefined> {
  return withDatabase(env, async (client) => {
    const result = await client.query<TrainingSampleRow>(
      'SELECT * FROM store_training_samples WHERE id = $1 AND store_id = $2 LIMIT 1',
      [sampleId, storeId],
    );
    return result.rows[0];
  });
}

function trainingReceiptCandidateView(row: TrainingReceiptCandidateRow) {
  return {
    id: row.id,
    publicId: row.public_id,
    status: row.status,
    imageUrl: `/api/admin/receipts/${row.id}/image`,
    expected: {
      ticketNumber: row.ticket_number || '',
      purchaseDate: row.purchase_date ? String(row.purchase_date).slice(0, 10) : '',
      purchaseDateTime: row.ocr_payload?.purchaseDateTime || '',
      totalCents: Number(row.total_cents || 0),
      currency: row.currency || 'EUR',
    },
    user: {
      subject: row.user_ref,
      displayName: row.user_display_name || '',
      email: row.user_email || '',
    },
    createdAt: row.created_at,
  };
}

async function handleAdminTrainingReceiptCandidates(
  request: Request,
  env: Env,
  storeId: string,
): Promise<Response> {
  if (!managerIdentity(request, env)) return error('Acceso de gestor requerido', 401);
  const url = new URL(request.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(24, Math.max(6, Number.parseInt(url.searchParams.get('pageSize') || '12', 10) || 12));
  const offset = (page - 1) * pageSize;
  const search = String(url.searchParams.get('query') || '').trim().slice(0, 160);
  const values: unknown[] = [storeId];
  let searchClause = '';
  if (search) {
    values.push(`%${search}%`);
    searchClause = ` AND (
      r.public_id ILIKE $2 OR r.ticket_number ILIKE $2 OR r.user_ref ILIKE $2
      OR s.display_name ILIKE $2 OR s.user_email ILIKE $2
    )`;
  }
  const result = await withDatabase(env, async (client) => {
    const storeResult = await client.query<Pick<StoreRow, 'id' | 'name'>>(
      'SELECT id, name FROM stores WHERE id = $1 LIMIT 1',
      [storeId],
    );
    if (!storeResult.rows[0]) return null;
    const countResult = await client.query<{ total: number }>(
      `SELECT COUNT(*) AS total
         FROM receipts r JOIN player_sessions s ON s.id = r.session_id
        WHERE r.store_id = $1 AND r.status <> 'DUPLICATE'${searchClause}`,
      values,
    );
    const rows = await client.query<TrainingReceiptCandidateRow>(
      `SELECT r.id, r.public_id, r.status, r.ticket_number, r.purchase_date, r.ocr_payload,
              r.total_cents, r.currency, r.created_at, r.user_ref,
              s.display_name AS user_display_name, s.user_email
         FROM receipts r JOIN player_sessions s ON s.id = r.session_id
        WHERE r.store_id = $1 AND r.status <> 'DUPLICATE'${searchClause}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      values,
    );
    return {
      store: storeResult.rows[0],
      total: Number(countResult.rows[0]?.total || 0),
      rows: rows.rows,
    };
  });
  if (!result) return error('Comercio no encontrado', 404);
  const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
  return json({
    success: true,
    store: result.store,
    receipts: result.rows.map(trainingReceiptCandidateView),
    pagination: {
      page,
      pageSize,
      total: result.total,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
    },
  });
}

async function handleAdminTrainingSamples(request: Request, env: Env, storeId: string): Promise<Response> {
  const managerEmail = managerIdentity(request, env);
  if (!managerEmail) return error('Acceso de gestor requerido', 401);
  const store = await withDatabase(env, async (client) => {
    const result = await client.query<StoreRow>('SELECT * FROM stores WHERE id = $1 LIMIT 1', [storeId]);
    return result.rows[0];
  });
  if (!store) return error('Comercio no encontrado', 404);

  if (request.method === 'GET') {
    const samples = await withDatabase(env, async (client) => {
      const result = await client.query<TrainingSampleRow>(
        `SELECT s.*,
            e.id AS evaluation_id, e.provider AS evaluation_provider,
            e.model AS evaluation_model, e.status AS evaluation_status,
            e.matches AS evaluation_matches,
            e.verification_issues AS evaluation_verification_issues,
            e.attempt_count AS evaluation_attempt_count,
            e.duration_ms AS evaluation_duration_ms,
            e.error_message AS evaluation_error_message,
            e.created_at AS evaluation_created_at
           FROM store_training_samples s
           LEFT JOIN store_training_evaluations e ON e.id = (
             SELECT latest.id FROM store_training_evaluations latest
              WHERE latest.sample_id = s.id
              ORDER BY latest.created_at DESC LIMIT 1
           )
          WHERE s.store_id = $1
          ORDER BY s.created_at DESC`,
        [storeId],
      );
      return result.rows;
    });
    return json({ success: true, store: storeView(store), samples: samples.map(trainingSampleView) });
  }

  const form = await request.formData();
  const sourceReceiptId = String(form.get('sourceReceiptId') || '').trim();
  const image = form.get('image');
  const maxBytes = Math.max(1, Number(env.MAX_TICKET_BYTES || 10 * 1024 * 1024));
  const input = normalizeTrainingSampleInput({
    ticketNumber: form.get('ticketNumber'),
    purchaseDate: form.get('purchaseDate'),
    purchaseDateTime: form.get('purchaseDateTime'),
    totalCents: form.get('totalCents'),
    currency: form.get('currency'),
    notes: form.get('notes'),
  });
  let originalBytes: ArrayBuffer;
  let originalContentType: string;
  if (sourceReceiptId) {
    const sourceReceipt = await withDatabase(env, async (client) => {
      const result = await client.query<Pick<ReceiptRow, 'image_key' | 'image_content_type'>>(
        `SELECT image_key, image_content_type FROM receipts
          WHERE id = $1 AND store_id = $2 AND status <> 'DUPLICATE' LIMIT 1`,
        [sourceReceiptId, storeId],
      );
      return result.rows[0];
    });
    if (!sourceReceipt) return error('El ticket seleccionado no pertenece a este comercio', 404);
    const sourceObject = await env.TICKETS.get(sourceReceipt.image_key);
    if (!sourceObject) return error('La imagen del ticket seleccionado no está disponible', 404);
    originalBytes = await sourceObject.arrayBuffer();
    originalContentType = sourceReceipt.image_content_type;
  } else {
    if (!(image instanceof File)) return error('Selecciona una imagen de ticket', 400);
    if (!new Set(['image/jpeg', 'image/png', 'image/webp']).has(image.type)) {
      return error('Formato de imagen no admitido', 415);
    }
    originalBytes = await image.arrayBuffer();
    originalContentType = image.type;
  }
  if (originalBytes.byteLength <= 0 || originalBytes.byteLength > maxBytes) {
    return error('La imagen supera el límite permitido', 413);
  }
  const optimized = await optimizeTicketImage(env, originalBytes, originalContentType);
  const sampleId = uuid();
  const objectKey = `training/${storeId}/${sampleId}.${optimized.extension}`;
  await env.TICKETS.put(objectKey, optimized.bytes, {
    httpMetadata: { contentType: optimized.contentType },
    customMetadata: {
      kind: 'ocr-training-sample',
      storeId,
      sampleId,
      originalBytes: String(optimized.originalBytes),
      storedBytes: String(optimized.bytes.byteLength),
      storedDimensions: `${optimized.width}x${optimized.height}`,
      ocrReady: 'true',
      ...(sourceReceiptId ? { sourceReceiptId } : {}),
    },
  });
  let created: TrainingSampleRow;
  try {
    created = await withDatabase(env, async (client) => {
      const result = await client.query<TrainingSampleRow>(
        `INSERT INTO store_training_samples
          (id, store_id, image_key, image_content_type, image_size, image_width, image_height,
           expected_ticket_number, expected_purchase_date, expected_total_cents,
           expected_purchase_datetime, expected_currency, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [sampleId, storeId, objectKey, optimized.contentType, optimized.bytes.byteLength,
          optimized.width, optimized.height, input.ticketNumber, input.purchaseDate,
          input.totalCents, input.purchaseDateTime || null, input.currency, input.notes, managerEmail],
      );
      return result.rows[0]!;
    });
  } catch (caught) {
    try { await env.TICKETS.delete(objectKey); } catch (cleanupError) {
      console.error('Could not clean up unlinked training image', cleanupError);
    }
    throw caught;
  }
  return json({ success: true, sample: trainingSampleView(created) }, 201);
}

async function handleAdminTrainingImage(
  request: Request,
  env: Env,
  storeId: string,
  sampleId: string,
): Promise<Response> {
  if (!managerIdentity(request, env)) return error('Acceso de gestor requerido', 401);
  const sample = await loadTrainingSample(env, storeId, sampleId);
  if (!sample) return error('Ejemplo no encontrado', 404);
  const object = await env.TICKETS.get(sample.image_key);
  if (!object) return error('Imagen no encontrada', 404);
  return new Response(object.body, { headers: {
    'Content-Type': sample.image_content_type,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}

async function handleAdminTrainingDelete(
  request: Request,
  env: Env,
  storeId: string,
  sampleId: string,
): Promise<Response> {
  if (!managerIdentity(request, env)) return error('Acceso de gestor requerido', 401);
  const sample = await loadTrainingSample(env, storeId, sampleId);
  if (!sample) return error('Ejemplo no encontrado', 404);
  await withDatabase(env, async (client) => {
    await client.query('DELETE FROM store_training_samples WHERE id = $1 AND store_id = $2', [sampleId, storeId]);
  });
  try { await env.TICKETS.delete(sample.image_key); } catch (caught) {
    console.error('Could not remove training image', caught);
  }
  return json({ success: true });
}

async function handleAdminTrainingEvaluate(
  request: Request,
  env: Env,
  storeId: string,
  sampleId: string,
): Promise<Response> {
  const managerEmail = managerIdentity(request, env);
  if (!managerEmail) return error('Acceso de gestor requerido', 401);
  const data = await withDatabase(env, async (client) => {
    const sampleResult = await client.query<TrainingSampleRow>(
      'SELECT * FROM store_training_samples WHERE id = $1 AND store_id = $2 LIMIT 1',
      [sampleId, storeId],
    );
    const storeResult = await client.query<StoreRow>('SELECT * FROM stores WHERE id = $1 LIMIT 1', [storeId]);
    return { sample: sampleResult.rows[0], store: storeResult.rows[0] };
  });
  if (!data.sample || !data.store) return error('Ejemplo no encontrado', 404);
  const object = await env.TICKETS.get(data.sample.image_key);
  if (!object) return error('Imagen no encontrada', 404);
  const evaluationId = uuid();
  try {
    const result = await readReceipt(
      env,
      await object.arrayBuffer(),
      data.sample.image_content_type,
      [storeIdentity(data.store)],
    );
    const expected = normalizeTrainingSampleInput({
      ticketNumber: data.sample.expected_ticket_number,
      purchaseDate: String(data.sample.expected_purchase_date).slice(0, 10),
      purchaseDateTime: data.sample.expected_purchase_datetime || '',
      totalCents: data.sample.expected_total_cents,
      currency: data.sample.expected_currency,
      notes: data.sample.notes,
    });
    const matches = compareTrainingResult(
      expected,
      result.receipt,
      Boolean(findMatchingStore([data.store], result.receipt)),
      result.verificationIssues,
    );
    const status = trainingEvaluationPassed(matches) ? 'PASSED' : 'FAILED';
    const created = await withDatabase(env, async (client) => {
      const insert = await client.query<TrainingEvaluationRow>(
        `INSERT INTO store_training_evaluations
          (id, sample_id, provider, model, status, actual_payload, matches,
           verification_issues, attempt_count, duration_ms, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11)
         RETURNING *`,
        [evaluationId, sampleId, result.provider, result.model, status,
          JSON.stringify(result.receipt), JSON.stringify(matches), JSON.stringify(result.verificationIssues),
          result.attemptCount, result.durationMs, managerEmail],
      );
      return insert.rows[0]!;
    });
    return json({ success: true, evaluation: trainingEvaluationView(created) });
  } catch (caught) {
    const message = (caught instanceof Error ? caught.message : 'OCR_EVALUATION_FAILED').slice(0, 500);
    const created = await withDatabase(env, async (client) => {
      const insert = await client.query<TrainingEvaluationRow>(
        `INSERT INTO store_training_evaluations
          (id, sample_id, provider, model, status, matches, verification_issues,
           attempt_count, error_message, created_by)
         VALUES ($1, $2, $3, $4, 'ERROR', $5::jsonb, $6::jsonb, 0, $7, $8)
         RETURNING *`,
        [evaluationId, sampleId, env.OCR_PROVIDER || 'workers-ai', env.OCR_MODEL,
          JSON.stringify({}), JSON.stringify([]), message, managerEmail],
      );
      return insert.rows[0]!;
    });
    return json({ success: false, evaluation: trainingEvaluationView(created) }, 200);
  }
}

function rewardTierView(row: RewardTierRow) {
  return {
    id: row.id,
    minimumCents: row.minimum_cents,
    points: row.points,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function handleAdminRewardTiers(request: Request, env: Env): Promise<Response> {
  const managerEmail = managerIdentity(request, env);
  if (!managerEmail) return error('Acceso de gestor requerido', 401);
  if (request.method === 'GET') {
    const rows = await withDatabase(env, async (client) => {
      const result = await client.query<RewardTierRow>(
        'SELECT * FROM reward_tiers ORDER BY minimum_cents ASC',
      );
      return result.rows;
    });
    return json({ success: true, manager: managerEmail, tiers: rows.map(rewardTierView) });
  }
  const input = normalizeRewardTierInput(await readJson(request));
  const id = uuid();
  const created = await withDatabase(env, (client) => inTransaction(client, async () => {
    const duplicate = await client.query('SELECT id FROM reward_tiers WHERE minimum_cents = $1', [input.minimumCents]);
    if (duplicate.rowCount) return null;
    const result = await client.query<RewardTierRow>(
      `INSERT INTO reward_tiers (id, minimum_cents, points, active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, input.minimumCents, input.points, input.active],
    );
    await client.query(
      `INSERT INTO reward_tier_audit_log (id, reward_tier_id, action, manager_email, changes)
       VALUES ($1, $2, 'CREATED', $3, $4::jsonb)`,
      [uuid(), id, managerEmail, JSON.stringify(input)],
    );
    return result.rows[0];
  }));
  if (!created) return error('Ya existe un tramo para ese importe mínimo', 409);
  return json({ success: true, tier: rewardTierView(created) }, 201);
}

async function handleAdminRewardTierUpdate(request: Request, env: Env, tierId: string): Promise<Response> {
  const managerEmail = managerIdentity(request, env);
  if (!managerEmail) return error('Acceso de gestor requerido', 401);
  const input = normalizeRewardTierInput(await readJson(request));
  const updated = await withDatabase(env, (client) => inTransaction(client, async () => {
    const currentResult = await client.query<RewardTierRow>('SELECT * FROM reward_tiers WHERE id = $1 FOR UPDATE', [tierId]);
    const current = currentResult.rows[0];
    if (!current) return { kind: 'missing' as const };
    const duplicate = await client.query(
      'SELECT id FROM reward_tiers WHERE minimum_cents = $1 AND id <> $2',
      [input.minimumCents, tierId],
    );
    if (duplicate.rowCount) return { kind: 'duplicate' as const };
    const action = current.active !== input.active ? (input.active ? 'ACTIVATED' : 'DEACTIVATED') : 'UPDATED';
    const changes = {
      before: { minimumCents: current.minimum_cents, points: current.points, active: current.active },
      after: input,
    };
    const result = await client.query<RewardTierRow>(
      `UPDATE reward_tiers SET minimum_cents = $2, points = $3, active = $4,
          updated_at = NOW() WHERE id = $1 RETURNING *`,
      [tierId, input.minimumCents, input.points, input.active],
    );
    await client.query(
      `INSERT INTO reward_tier_audit_log (id, reward_tier_id, action, manager_email, changes)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [uuid(), tierId, action, managerEmail, JSON.stringify(changes)],
    );
    return { kind: 'updated' as const, row: result.rows[0]! };
  }));
  if (updated.kind === 'missing') return error('Tramo no encontrado', 404);
  if (updated.kind === 'duplicate') return error('Ya existe un tramo para ese importe mínimo', 409);
  return json({ success: true, tier: rewardTierView(updated.row) });
}

function appSettingView(definition: typeof APP_SETTING_DEFINITIONS[number], value: string) {
  return {
    key: definition.key,
    group: definition.group,
    label: definition.label,
    help: definition.help,
    format: definition.format,
    value,
    maxLength: definition.maxLength,
  };
}

async function handleAdminSettings(request: Request, env: Env): Promise<Response> {
  const manager = managerIdentity(request, env);
  if (!manager) return error('Acceso de gestor requerido', 401);
  const values = await withDatabase(env, loadAppSettings);
  return json({
    success: true,
    manager,
    settings: APP_SETTING_DEFINITIONS.map((definition) => appSettingView(definition, values[definition.key]!)),
  });
}

async function authorizedAdmin(request: Request, env: Env): Promise<AdminUserRow | null> {
  const email = managerIdentity(request, env);
  if (!email) return null;
  return withDatabase(env, async (client) => {
    let result = await client.query<AdminUserRow>(
      'SELECT * FROM admin_users WHERE email = $1 AND active = TRUE LIMIT 1', [email.toLowerCase()],
    );
    if (!result.rows[0]) {
      const count = await client.query<{ total: number }>('SELECT COUNT(*) AS total FROM admin_users');
      if (Number(count.rows[0]?.total || 0) === 0) {
        const id = uuid();
        await client.query(
          `INSERT INTO admin_users (id, email, role, created_by)
           VALUES ($1, $2, 'SUPERADMIN', $2) ON CONFLICT(email) DO NOTHING`,
          [id, email.toLowerCase()],
        );
        const created = await client.query<AdminUserRow>('SELECT * FROM admin_users WHERE email = $1 LIMIT 1', [email.toLowerCase()]);
        if (created.rows[0]?.role === 'SUPERADMIN') {
          await client.query(
            `INSERT INTO admin_user_audit_log (id, admin_user_id, action, manager_email)
             VALUES ($1, $2, 'BOOTSTRAPPED', $3)`,
            [uuid(), created.rows[0].id, email.toLowerCase()],
          );
        }
        result = created;
      }
    }
    const admin = result.rows[0];
    if (admin) await client.query('UPDATE admin_users SET last_accessed_at = NOW() WHERE id = $1', [admin.id]);
    return admin || null;
  });
}

function adminUserView(row: AdminUserRow) {
  return {
    id: row.id, email: row.email, role: row.role, active: row.active,
    createdBy: row.created_by, createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
  };
}

async function activeAdminEmails(env: Env): Promise<string[]> {
  return withDatabase(env, async (client) => {
    const result = await client.query<Pick<AdminUserRow, 'email'>>(
      'SELECT email FROM admin_users WHERE active = TRUE ORDER BY email ASC',
    );
    return result.rows.map((row) => row.email);
  });
}

async function handleAdminUsers(request: Request, env: Env): Promise<Response> {
  const current = await authorizedAdmin(request, env);
  if (!current) return error('Acceso de administrador requerido', 403);
  const accessConfigured = Boolean(env.CLOUDFLARE_ACCESS_API_TOKEN && env.CLOUDFLARE_ACCESS_EMAIL_LIST_ID && env.CLOUDFLARE_ACCOUNT_ID);
  const mailConfigured = adminInvitationMailConfigured(env);
  const backofficeUrl = env.ADMIN_BACKOFFICE_URL || `${new URL(request.url).origin}/backoffice`;
  if (request.method === 'GET') {
    const users = await withDatabase(env, async (client) => {
      const result = await client.query<AdminUserRow>('SELECT * FROM admin_users WHERE active = TRUE ORDER BY role DESC, email ASC');
      return result.rows;
    });
    return json({ success: true, current: adminUserView(current), users: users.map(adminUserView), accessConfigured, mailConfigured, backofficeUrl });
  }
  if (current.role !== 'SUPERADMIN') return error('Solo el superadministrador puede crear usuarios', 403);
  const body = await readJson(request);
  const email = normalizeAdminEmail(body.email);
  const created = await withDatabase(env, async (client) => {
    const existing = await client.query<AdminUserRow>('SELECT * FROM admin_users WHERE email = $1 LIMIT 1', [email]);
    if (existing.rows[0]) {
      const updated = await client.query<AdminUserRow>(
        `UPDATE admin_users SET active = TRUE, role = 'ADMIN', updated_at = NOW(), created_by = $2
          WHERE id = $1 RETURNING *`, [existing.rows[0].id, current.email],
      );
      return updated.rows[0]!;
    }
    const id = uuid();
    const inserted = await client.query<AdminUserRow>(
      `INSERT INTO admin_users (id, email, role, created_by)
       VALUES ($1, $2, 'ADMIN', $3) RETURNING *`, [id, email, current.email],
    );
    await client.query(
      `INSERT INTO admin_user_audit_log (id, admin_user_id, action, manager_email)
       VALUES ($1, $2, 'CREATED', $3)`, [uuid(), id, current.email],
    );
    return inserted.rows[0]!;
  });
  const accessSynced = await syncAdminAccessEmails(env, await activeAdminEmails(env));
  let invitationSent = false;
  try {
    invitationSent = await sendAdminInvitation(env, { email, backofficeUrl, invitedBy: current.email });
  } catch {
    invitationSent = false;
  }
  return json({ success: true, user: adminUserView(created), accessSynced, invitationSent, backofficeUrl }, 201);
}

async function handleAdminUserDelete(request: Request, env: Env, userId: string): Promise<Response> {
  const current = await authorizedAdmin(request, env);
  if (!current) return error('Acceso de administrador requerido', 403);
  if (current.role !== 'SUPERADMIN') return error('Solo el superadministrador puede eliminar usuarios', 403);
  const deleted = await withDatabase(env, async (client) => {
    const result = await client.query<AdminUserRow>('SELECT * FROM admin_users WHERE id = $1 AND active = TRUE LIMIT 1', [userId]);
    const target = result.rows[0];
    if (!target) return null;
    if (target.id === current.id || target.role === 'SUPERADMIN') throw new Error('SUPERADMIN_DELETE_FORBIDDEN');
    await client.query('UPDATE admin_users SET active = FALSE, updated_at = NOW() WHERE id = $1', [userId]);
    await client.query(
      `INSERT INTO admin_user_audit_log (id, admin_user_id, action, manager_email)
       VALUES ($1, $2, 'DELETED', $3)`, [uuid(), userId, current.email],
    );
    return target;
  });
  if (!deleted) return error('Administrador no encontrado', 404);
  const accessSynced = await syncAdminAccessEmails(env, await activeAdminEmails(env));
  return json({ success: true, accessSynced });
}

async function cleanupLiftedBan(env: Env, externalUserId: string, managerEmail: string): Promise<boolean> {
  const offenses = await withDatabase(env, async (client) => {
    const result = await client.query<ReceiptRow>(
      `SELECT r.* FROM user_offenses o JOIN receipts r ON r.id = o.receipt_id
        WHERE o.external_user_id = $1 AND o.active = TRUE ORDER BY o.created_at ASC`,
      [externalUserId],
    );
    return result.rows;
  });
  let pending = false;
  for (const receipt of offenses) {
    if (receipt.rtales_result_id && receipt.status !== 'REVOKED') {
      let outboxId = '';
      await withDatabase(env, (client) => inTransaction(client, async () => {
        await client.query(
          `UPDATE receipts SET status = 'REVOKE_PENDING', deletion_requested_at = NOW(),
             deletion_requested_by = $2, updated_at = NOW() WHERE id = $1`,
          [receipt.id, managerEmail],
        );
        const existing = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM reward_outbox WHERE receipt_id = $1 AND operation = 'REVOKE'
            ORDER BY created_at DESC LIMIT 1`, [receipt.id],
        );
        outboxId = existing.rows[0]?.id || uuid();
        if (existing.rows[0]?.status === 'FAILED') {
          await client.query(
            `UPDATE reward_outbox SET status = 'PENDING', attempt_count = 0, next_attempt_at = NOW(),
               locked_until = NULL, last_error = NULL, updated_at = NOW() WHERE id = $1`, [outboxId],
          );
        } else if (!existing.rows[0]) {
          await client.query(
            `INSERT INTO reward_outbox (id, receipt_id, operation, idempotency_key, payload)
             VALUES ($1, $2, 'REVOKE', $3, $4::jsonb)`,
            [outboxId, receipt.id, reversalIdempotencyKey(receipt.id), JSON.stringify({
              reason: 'Limpieza de imágenes infractoras al desbanear', managerEmail,
            })],
          );
        }
      }));
      await env.REWARD_JOBS.send({ kind: 'DELIVER_REWARD', outboxId });
      pending = true;
    } else {
      await purgeReceipt(env, receipt.id, managerEmail);
    }
  }
  if (pending) return false;
  await withDatabase(env, (client) => inTransaction(client, async () => {
    await client.query(
      `UPDATE user_offenses SET active = FALSE, cleared_at = NOW()
        WHERE external_user_id = $1 AND active = TRUE`, [externalUserId],
    );
    await client.query(
      `UPDATE user_bans SET status = 'LIFTED', offense_score = 0, lifted_at = NOW(),
         updated_at = NOW() WHERE external_user_id = $1 AND status = 'LIFTING'`, [externalUserId],
    );
  }));
  return true;
}

async function handleAdminBans(request: Request, env: Env): Promise<Response> {
  const manager = managerIdentity(request, env);
  if (!manager) return error('Acceso de gestor requerido', 401);
  const query = String(new URL(request.url).searchParams.get('q') || '').trim();
  const normalized = normalizeLookupCode(query);
  const bans = await withDatabase(env, async (client) => {
    const result = await client.query<UserBanRow & {
      rtales_lookup_code: string; display_name: string; email: string | null;
      space_code: string; installation_id: string; offense_count: number;
    }>(
      `SELECT b.*, u.rtales_lookup_code, u.display_name, u.email, u.space_code, u.installation_id,
          (SELECT COUNT(*) FROM user_offenses o WHERE o.external_user_id = b.external_user_id AND o.active = TRUE) AS offense_count
        FROM user_bans b JOIN external_users u ON u.id = b.external_user_id
       WHERE b.status IN ('ACTIVE', 'LIFTING')
         AND ($1 = '' OR u.rtales_lookup_code_normalized = $1 OR u.display_name ILIKE $2)
       ORDER BY b.banned_at DESC, b.updated_at DESC`,
      [normalized, `%${query}%`],
    );
    return result.rows;
  });
  return json({ success: true, manager, bans: bans.map((ban) => ({
    id: ban.id, externalUserId: ban.external_user_id, status: ban.status,
    offenseScore: Number(ban.offense_score), offenseCount: Number(ban.offense_count),
    reason: ban.reason, bannedAt: ban.banned_at, bannedBy: ban.banned_by,
    lookupCode: ban.rtales_lookup_code, displayName: ban.display_name, email: ban.email,
    spaceCode: ban.space_code, installationId: ban.installation_id,
  })) });
}

async function handleAdminBanLift(request: Request, env: Env, banId: string): Promise<Response> {
  const manager = managerIdentity(request, env);
  if (!manager) return error('Acceso de gestor requerido', 401);
  const ban = await withDatabase(env, async (client) => {
    const result = await client.query<UserBanRow>(
      `UPDATE user_bans SET status = 'LIFTING', lifting_at = NOW(), lifting_by = $2,
         updated_at = NOW() WHERE id = $1 AND status IN ('ACTIVE', 'LIFTING') RETURNING *`,
      [banId, manager],
    );
    return result.rows[0];
  });
  if (!ban) return error('Baneo no encontrado', 404);
  const completed = await cleanupLiftedBan(env, ban.external_user_id, manager);
  return json({ success: true, completed, status: completed ? 'LIFTED' : 'LIFTING' }, completed ? 200 : 202);
}

async function handleAdminSettingUpdate(
  request: Request,
  env: Env,
  settingKey: string,
): Promise<Response> {
  const manager = managerIdentity(request, env);
  if (!manager) return error('Acceso de gestor requerido', 401);
  const definition = settingDefinition(settingKey);
  const body = await readJson(request);
  const value = normalizeAppSettingValue(settingKey, body.value);
  const updated = await withDatabase(env, (client) => inTransaction(client, async () => {
    const currentValues = await loadAppSettings(client);
    validateAppSettingPeriod({ ...currentValues, [settingKey]: value });
    const currentResult = await client.query<Pick<AppSettingRow, 'value'>>(
      'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
      [settingKey],
    );
    const previousValue = currentResult.rows[0]?.value ?? definition.defaultValue;
    const result = await client.query<AppSettingRow>(
      `INSERT INTO app_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3
       RETURNING *`,
      [settingKey, value, manager],
    );
    await client.query(
      `INSERT INTO app_setting_audit_log
         (id, setting_key, manager_email, previous_value, new_value)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuid(), settingKey, manager, previousValue, value],
    );
    return result.rows[0]!;
  }));
  return json({ success: true, setting: appSettingView(definition, updated.value) });
}

async function handleAdminValidationPeriod(request: Request, env: Env): Promise<Response> {
  const manager = managerIdentity(request, env);
  if (!manager) return error('Acceso de gestor requerido', 401);
  const body = await readJson(request);
  const startAt = normalizeAppSettingValue('validation.startAt', body.startAt);
  const endAt = normalizeAppSettingValue('validation.endAt', body.endAt);
  validateAppSettingPeriod({ 'validation.startAt': startAt, 'validation.endAt': endAt });
  await withDatabase(env, (client) => inTransaction(client, async () => {
    for (const [key, value] of [['validation.startAt', startAt], ['validation.endAt', endAt]]) {
      const current = await client.query<Pick<AppSettingRow, 'value'>>('SELECT value FROM app_settings WHERE key = $1 LIMIT 1', [key]);
      await client.query(
        `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, NOW(), $3)
         ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
        [key, value, manager],
      );
      await client.query(
        `INSERT INTO app_setting_audit_log (id, setting_key, manager_email, previous_value, new_value)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuid(), key, manager, current.rows[0]?.value || '', value],
      );
    }
  }));
  return json({ success: true, startAt, endAt });
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (env.ADMIN_ONLY === 'true') {
      if (url.pathname === '/') return Response.redirect(`${url.origin}/backoffice`, 302);
      const adminAsset = ['/backoffice', '/backoffice.html', '/backoffice.js', '/styles.css', '/favicon.ico'].includes(url.pathname);
      if (!adminAsset && !url.pathname.startsWith('/api/admin/')) return error('Ruta no encontrada', 404);
      if (url.pathname.startsWith('/api/admin/') && !await authorizedAdmin(request, env)) {
        return error('Este correo no tiene acceso al backoffice', 403);
      }
    } else if (url.pathname.startsWith('/api/admin/')) {
      return error('Ruta no encontrada', 404);
    }
    if (request.method === 'POST' && url.pathname === '/api/session/exchange') return await handleExchange(request, env);
    if (request.method === 'GET' && url.pathname === '/api/stores') return await handleStores(request, env);
    if (request.method === 'GET' && url.pathname === '/api/home-settings') return await handleHomeSettings(request, env);
    const publicStoreLogoMatch = url.pathname.match(/^\/api\/stores\/([^/]+)\/logo$/);
    if (request.method === 'GET' && publicStoreLogoMatch?.[1]) {
      return await handleStoreLogo(request, env, publicStoreLogoMatch[1], false);
    }
    if (request.method === 'POST' && url.pathname === '/api/receipts') return await handleUpload(request, env);
    if (request.method === 'GET' && url.pathname === '/api/receipts') return await handleReceiptList(request, env);
    if (request.method === 'GET' && url.pathname === '/api/receipts/latest') {
      return await handleLatestPendingReceipt(request, env);
    }
    const receiptMatch = url.pathname.match(/^\/api\/receipts\/([^/]+)$/);
    if (request.method === 'GET' && receiptMatch?.[1]) return await handleReceiptStatus(request, env, receiptMatch[1]);
    const receiptImageMatch = url.pathname.match(/^\/api\/receipts\/([^/]+)\/image$/);
    if (request.method === 'GET' && receiptImageMatch?.[1]) return await handleReceiptImage(request, env, receiptImageMatch[1]);
    const confirmMatch = url.pathname.match(/^\/api\/receipts\/([^/]+)\/confirm$/);
    if (request.method === 'POST' && confirmMatch?.[1]) return await handleConfirm(request, env, confirmMatch[1]);
    if (request.method === 'GET' && url.pathname === '/api/admin/receipts') return await handleAdminList(request, env);
    if (request.method === 'GET' && url.pathname === '/api/admin/receipts.csv') return await handleAdminCsv(request, env);
    const adminReceiptMatch = url.pathname.match(/^\/api\/admin\/receipts\/([^/]+)$/);
    if (request.method === 'GET' && adminReceiptMatch?.[1]) return await handleAdminReceipt(request, env, adminReceiptMatch[1]);
    if (request.method === 'DELETE' && adminReceiptMatch?.[1]) return await handleAdminReceiptDelete(request, env, adminReceiptMatch[1]);
    if (url.pathname === '/api/admin/stores' && ['GET', 'POST'].includes(request.method)) {
      return await handleAdminStores(request, env);
    }
    const adminStoreLogoMatch = url.pathname.match(/^\/api\/admin\/stores\/([^/]+)\/logo$/);
    if (request.method === 'GET' && adminStoreLogoMatch?.[1]) {
      return await handleStoreLogo(request, env, adminStoreLogoMatch[1], true);
    }
    if (request.method === 'POST' && adminStoreLogoMatch?.[1]) {
      return await handleAdminStoreLogoUpload(request, env, adminStoreLogoMatch[1]);
    }
    const storeOcrProfileGenerateMatch = url.pathname.match(
      /^\/api\/admin\/stores\/([^/]+)\/ocr-profile\/generate$/,
    );
    if (request.method === 'POST' && storeOcrProfileGenerateMatch?.[1]) {
      return await handleAdminStoreOcrProfileGenerate(request, env, storeOcrProfileGenerateMatch[1]);
    }
    const storeOcrProfileMatch = url.pathname.match(/^\/api\/admin\/stores\/([^/]+)\/ocr-profile$/);
    if (storeOcrProfileMatch?.[1] && ['GET', 'PATCH'].includes(request.method)) {
      return await handleAdminStoreOcrProfile(request, env, storeOcrProfileMatch[1]);
    }
    const trainingCandidatesMatch = url.pathname.match(
      /^\/api\/admin\/stores\/([^/]+)\/training-candidates$/,
    );
    if (request.method === 'GET' && trainingCandidatesMatch?.[1]) {
      return await handleAdminTrainingReceiptCandidates(request, env, trainingCandidatesMatch[1]);
    }
    const trainingCollectionMatch = url.pathname.match(/^\/api\/admin\/stores\/([^/]+)\/training$/);
    if (trainingCollectionMatch?.[1] && ['GET', 'POST'].includes(request.method)) {
      return await handleAdminTrainingSamples(request, env, trainingCollectionMatch[1]);
    }
    const trainingImageMatch = url.pathname.match(
      /^\/api\/admin\/stores\/([^/]+)\/training\/([^/]+)\/image$/,
    );
    if (request.method === 'GET' && trainingImageMatch?.[1] && trainingImageMatch[2]) {
      return await handleAdminTrainingImage(request, env, trainingImageMatch[1], trainingImageMatch[2]);
    }
    const trainingEvaluateMatch = url.pathname.match(
      /^\/api\/admin\/stores\/([^/]+)\/training\/([^/]+)\/evaluate$/,
    );
    if (request.method === 'POST' && trainingEvaluateMatch?.[1] && trainingEvaluateMatch[2]) {
      return await handleAdminTrainingEvaluate(request, env, trainingEvaluateMatch[1], trainingEvaluateMatch[2]);
    }
    const trainingSampleMatch = url.pathname.match(
      /^\/api\/admin\/stores\/([^/]+)\/training\/([^/]+)$/,
    );
    if (request.method === 'DELETE' && trainingSampleMatch?.[1] && trainingSampleMatch[2]) {
      return await handleAdminTrainingDelete(request, env, trainingSampleMatch[1], trainingSampleMatch[2]);
    }
    const storeMatch = url.pathname.match(/^\/api\/admin\/stores\/([^/]+)$/);
    if (request.method === 'PATCH' && storeMatch?.[1]) return await handleAdminStoreUpdate(request, env, storeMatch[1]);
    if (url.pathname === '/api/admin/reward-tiers' && ['GET', 'POST'].includes(request.method)) {
      return await handleAdminRewardTiers(request, env);
    }
    const tierMatch = url.pathname.match(/^\/api\/admin\/reward-tiers\/([^/]+)$/);
    if (request.method === 'PATCH' && tierMatch?.[1]) return await handleAdminRewardTierUpdate(request, env, tierMatch[1]);
    if (request.method === 'GET' && url.pathname === '/api/admin/settings') {
      return await handleAdminSettings(request, env);
    }
    if (request.method === 'PATCH' && url.pathname === '/api/admin/settings/validation-period') {
      return await handleAdminValidationPeriod(request, env);
    }
    if (url.pathname === '/api/admin/users' && ['GET', 'POST'].includes(request.method)) {
      return await handleAdminUsers(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/bans') {
      return await handleAdminBans(request, env);
    }
    const adminBanLiftMatch = url.pathname.match(/^\/api\/admin\/bans\/([^/]+)\/lift$/);
    if (request.method === 'POST' && adminBanLiftMatch?.[1]) {
      return await handleAdminBanLift(request, env, adminBanLiftMatch[1]);
    }
    const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (request.method === 'DELETE' && adminUserMatch?.[1]) {
      return await handleAdminUserDelete(request, env, adminUserMatch[1]);
    }
    const settingMatch = url.pathname.match(/^\/api\/admin\/settings\/([^/]+)$/);
    if (request.method === 'PATCH' && settingMatch?.[1]) {
      return await handleAdminSettingUpdate(request, env, decodeURIComponent(settingMatch[1]));
    }
    const imageMatch = url.pathname.match(/^\/api\/admin\/receipts\/([^/]+)\/image$/);
    if (request.method === 'GET' && imageMatch?.[1]) return await handleAdminImage(request, env, imageMatch[1]);
    const reprocessMatch = url.pathname.match(/^\/api\/admin\/receipts\/([^/]+)\/reprocess$/);
    if (request.method === 'POST' && reprocessMatch?.[1]) return await handleAdminReprocess(request, env, reprocessMatch[1]);
    const reviewMatch = url.pathname.match(/^\/api\/admin\/receipts\/([^/]+)\/review$/);
    if (request.method === 'POST' && reviewMatch?.[1]) return await handleAdminReview(request, env, reviewMatch[1]);
    if (url.pathname.startsWith('/api/')) return error('Ruta no encontrada', 404);

    const assetResponse = await env.ASSETS.fetch(request);
    const response = new Response(assetResponse.body, assetResponse);
    if (env.ADMIN_ONLY === 'true') response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('Content-Security-Policy', `frame-ancestors ${env.RTALES_PARENT_ORIGINS.split(',').join(' ')}`);
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  } catch (caught) {
    console.error('Request failed', caught);
    if (caught instanceof RtalesApiError) {
      const status = caught.status >= 400 && caught.status <= 599 ? caught.status : 502;
      const rtalesErrors: Record<number, { message: string; code: string }> = {
        400: { message: 'El código de acceso al sistema no es válido', code: 'RTALES_LAUNCH_INVALID' },
        401: { message: 'La conexión con el sistema no está configurada correctamente', code: 'RTALES_CONFIGURATION_ERROR' },
        403: { message: 'La conexión con el sistema no tiene los permisos necesarios', code: 'RTALES_CONFIGURATION_ERROR' },
        404: { message: 'La sesión del sistema ya no está disponible', code: 'RTALES_LAUNCH_UNAVAILABLE' },
        409: { message: 'El código de acceso ya se ha utilizado', code: 'RTALES_LAUNCH_CONFLICT' },
        410: { message: 'La sesión de acceso ha caducado', code: 'RTALES_LAUNCH_EXPIRED' },
        429: { message: 'El sistema está recibiendo demasiadas solicitudes', code: 'RTALES_RATE_LIMITED' },
      };
      const mapped = rtalesErrors[status] || (status >= 500
        ? { message: 'El sistema no está disponible temporalmente', code: 'RTALES_UNAVAILABLE' }
        : { message: 'El sistema no pudo iniciar la sesión del jugador', code: 'RTALES_EXCHANGE_FAILED' });
      return error(mapped.message, status, mapped.code);
    }
    const message = caught instanceof Error ? caught.message : 'UNKNOWN_ERROR';
    const validationErrors: Record<string, string> = {
      INVALID_JSON: 'JSON no válido',
      STORE_CODE_INVALID: 'El código debe tener entre 2 y 40 caracteres: letras, números, guion o guion bajo',
      STORE_NAME_INVALID: 'El nombre debe tener entre 2 y 160 caracteres',
      STORE_ALIAS_INVALID: 'Los alias no pueden superar 160 caracteres',
      IMAGE_INVALID: 'La imagen seleccionada no es válida',
      TRAINING_TICKET_NUMBER_INVALID: 'Indica un número de ticket válido para el ejemplo',
      TRAINING_DATE_INVALID: 'Indica una fecha válida para el ejemplo',
      TRAINING_TOTAL_INVALID: 'Indica un importe total válido para el ejemplo',
      TRAINING_CURRENCY_INVALID: 'La moneda del ejemplo no es válida',
      TRAINING_NOTES_TOO_LONG: 'Las notas del ejemplo son demasiado largas',
      TIER_MINIMUM_INVALID: 'El importe mínimo debe ser un valor válido en céntimos',
      TIER_POINTS_INVALID: 'Los puntos deben ser un número entero positivo o cero',
      APP_SETTING_UNKNOWN: 'El ajuste seleccionado no existe',
      APP_SETTING_VALUE_INVALID: 'El contenido del ajuste no es válido',
      APP_SETTING_TOO_LONG: 'El texto supera la longitud permitida',
      APP_SETTING_DATETIME_INVALID: 'La fecha y hora no tienen un formato válido',
      APP_SETTING_PERIOD_INVALID: 'La fecha de inicio debe ser anterior a la fecha de fin',
      ADMIN_EMAIL_INVALID: 'Introduce un correo electrónico válido',
      SUPERADMIN_DELETE_FORBIDDEN: 'El superadministrador actual no se puede eliminar',
    };
    return error(validationErrors[message] || 'No se pudo completar la operación', validationErrors[message] ? 400 : 500);
  }
}

async function requeueDueOutbox(env: Env): Promise<void> {
  const maxAttempts = rewardMaxAttempts(env);
  const ids = await withDatabase(env, async (client) => {
    const exhausted = await client.query<{ id: string }>(
      `SELECT id FROM reward_outbox
        WHERE status IN ('PENDING', 'PROCESSING') AND attempt_count >= $1
        LIMIT 100`,
      [maxAttempts],
    );
    const result = await client.query<{ id: string }>(
      `UPDATE reward_outbox SET status = 'PENDING', locked_until = NULL, updated_at = NOW()
        WHERE status = 'PROCESSING' AND locked_until < NOW() AND attempt_count < $1
        RETURNING id`,
      [maxAttempts],
    );
    const due = await client.query<{ id: string }>(
      `SELECT id FROM reward_outbox
        WHERE status = 'PENDING' AND next_attempt_at <= NOW() AND attempt_count < $1
        LIMIT 100`,
      [maxAttempts],
    );
    return { exhausted: exhausted.rows, due: Array.from(new Set([...result.rows, ...due.rows].map((row) => row.id))) };
  });
  await Promise.all(ids.exhausted.map(({ id }) => markOutboxTerminalFailure(env, id, 'RTALES_MAX_ATTEMPTS')));
  await Promise.all(ids.due.map((outboxId) => env.REWARD_JOBS.send({ kind: 'DELIVER_REWARD', outboxId })));
}

async function requeueStuckOcr(env: Env): Promise<void> {
  const receipts = await withDatabase(env, async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE receipts SET status = 'OCR_QUEUED', updated_at = NOW()
        WHERE id IN (
          SELECT id FROM receipts
           WHERE status = 'OCR_PROCESSING'
             AND updated_at < datetime('now', '-2 minutes')
           ORDER BY updated_at ASC
           LIMIT 50
        )
        RETURNING id`,
    );
    return result.rows;
  });
  await Promise.all(receipts.map(({ id }) => env.OCR_JOBS.send({ kind: 'OCR_RECEIPT', receiptId: id })));
}

async function continueBanCleanups(env: Env): Promise<void> {
  const bans = await withDatabase(env, async (client) => {
    const result = await client.query<Pick<UserBanRow, 'external_user_id' | 'lifting_by'>>(
      `SELECT external_user_id, lifting_by FROM user_bans
        WHERE status = 'LIFTING' ORDER BY lifting_at ASC LIMIT 20`,
    );
    return result.rows;
  });
  for (const ban of bans) {
    await cleanupLiftedBan(env, ban.external_user_id, ban.lifting_by || 'SYSTEM');
  }
}

export default {
  fetch: handleFetch,
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (message.body.kind === 'OCR_RECEIPT') await processOcr(env, message.body.receiptId);
        else {
          const retryDelaySeconds = await processOutbox(env, message.body.outboxId);
          if (retryDelaySeconds !== null) {
            message.retry({ delaySeconds: retryDelaySeconds });
            continue;
          }
        }
        message.ack();
      } catch (caught) {
        console.error('Queue job failed', message.body, caught);
        if (message.body.kind === 'OCR_RECEIPT') {
          const failure = classifyOcrFailure(caught);
          await recordOcrFailure(env, message.body.receiptId, failure.error);
          if (!failure.retryable || message.attempts >= ocrMaxAttempts(env.OCR_MAX_ATTEMPTS)) {
            await markOcrFailed(env, message.body.receiptId, failure.reason, failure.error);
            message.ack();
          } else {
            message.retry({ delaySeconds: ocrRetryDelaySeconds(message.attempts) });
          }
        } else if (message.attempts >= rewardMaxAttempts(env)) {
          await markOutboxTerminalFailure(env, message.body.outboxId, 'REWARD_JOB_FAILED');
          message.ack();
        } else {
          message.retry();
        }
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(Promise.all([requeueDueOutbox(env), requeueStuckOcr(env), continueBanCleanups(env)]));
  },
} satisfies ExportedHandler<Env, JobMessage>;
