import type { DbClient } from './platform/db';
import { buildTicketFingerprint } from './domain/deduplication';
import {
  type OcrReceipt,
  type ReceiptFields,
  validateReceiptAutomatically,
} from './domain/receipt';
import {
  resolveRewardPoints,
  reversalIdempotencyKey,
  rewardIdempotencyKey,
} from './domain/rewards';
import { normalizeStoreInput } from './domain/store';
import { normalizeRewardTierInput } from './domain/reward-tier';
import { readReceipt } from './integrations/ocr';
import {
  exchangeLaunchCode,
  grantTicketPoints,
  RtalesApiError,
  revokeTicketPoints,
} from './integrations/rtales';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from './platform/crypto';
import { inTransaction, withDatabase } from './platform/db';
import { optimizeTicketImage } from './platform/image';
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
  user_ref: string;
  rtales_game_session_id: string;
  player_token_encrypted: string;
  parent_origin: string | null;
  display_name: string | null;
  user_email: string | null;
};

type ReceiptRow = {
  id: string;
  public_id: string;
  session_id: string;
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
  ocr_payload: OcrReceipt | null;
  ocr_confidence: number | null;
  risk_score: number;
  validation_reasons: string[];
  review_status: 'PENDING' | 'CLEARED' | 'FRAUD';
  reviewed_at: string | null;
  reviewed_by: string | null;
  user_display_name?: string | null;
  user_email?: string | null;
  points_awarded: number;
  rtales_result_id: string | null;
  rtales_reversal_id: string | null;
  created_at: string;
  rewarded_at: string | null;
  revoked_at: string | null;
};

type StoreRow = {
  id: string;
  code: string;
  name: string;
  aliases: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
  receipt_count?: string;
};

type RewardTierRow = {
  id: string;
  minimum_cents: number;
  points: number;
  active: boolean;
  created_at: string;
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
  return {
    id: row.id,
    publicId: row.public_id,
    status: row.status,
    fields: {
      storeId: row.store_id || '',
      storeName: row.store_name || '',
      ticketNumber: row.ticket_number || '',
      purchaseDate: row.purchase_date || '',
      totalCents: row.total_cents || 0,
      currency: row.currency,
    },
    ocr: row.ocr_payload,
    riskScore: row.risk_score,
    reasons: row.validation_reasons,
    review: {
      status: row.review_status,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by,
    },
    ...(includeManagerFields ? {
      user: {
        subject: row.user_ref,
        displayName: row.user_display_name || '',
        email: row.user_email || '',
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
              parent_origin, display_name, user_email
         FROM player_sessions
        WHERE access_token_hash = $1 AND expires_at > NOW()
        LIMIT 1`,
      [tokenHash],
    );
    return result.rows[0] ?? null;
  };
  return client ? query(client) : withDatabase(env, query);
}

async function handleExchange(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const launchCode = String(body.launchCode || '').trim();
  if (!launchCode.startsWith('rtgl_')) return error('Código de lanzamiento inválido', 400);
  const exchange = await exchangeLaunchCode(env, launchCode);
  const player = exchange.player as Record<string, unknown> | undefined;
  const playerSubject = String(player?.subject || '').trim();
  if (!playerSubject) {
    return error('Rtales todavía no entrega player.subject para identificar al usuario', 503, 'PLAYER_SUBJECT_REQUIRED');
  }
  const gameSessionId = String(exchange.gameSessionId || '');
  const playerToken = String(exchange.playerToken || '');
  if (!gameSessionId || !playerToken) return error('Respuesta incompleta de Rtales', 502);

  const sessionToken = `tkts_${randomToken()}`;
  const sessionId = uuid();
  const parentOrigin = allowedParentOrigin(body.parentOrigin, env);
  const encryptedPlayerToken = await encryptSecret(playerToken, env.DATA_ENCRYPTION_KEY);
  await withDatabase(env, async (client) => {
    await client.query(
      `INSERT INTO player_sessions
         (id, access_token_hash, user_ref, rtales_game_session_id,
          player_token_encrypted, parent_origin, display_name, user_email, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '24 hours')`,
      [
        sessionId,
        await sha256Hex(sessionToken),
        playerSubject,
        gameSessionId,
        encryptedPlayerToken,
        parentOrigin,
        String(player?.displayName || ''),
        String(player?.email || '').trim().toLowerCase() || null,
      ],
    );
  });
  return json({
    success: true,
    sessionToken,
    player: { displayName: String(player?.displayName || '') },
    parentOrigin,
  }, 201);
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const session = await authenticatedSession(request, env);
  if (!session) return error('Sesión no válida', 401);
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
        originalDimensions: `${storedImage.width}x${storedImage.height}`,
      },
      sha256: digest,
    });
    await client.query(
      `INSERT INTO receipts
         (id, public_id, session_id, user_ref, image_key, image_sha256,
          image_content_type, image_size, status, validation_reasons)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
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
      ],
    );
    return Boolean(existing.rowCount);
  });

  if (!duplicate) await env.JOBS.send({ kind: 'OCR_RECEIPT', receiptId });
  return json({ success: true, receiptId, publicId: ticketPublicId, status: duplicate ? 'DUPLICATE' : 'OCR_QUEUED' }, 202);
}

async function handleStores(request: Request, env: Env): Promise<Response> {
  const session = await authenticatedSession(request, env);
  if (!session) return error('Sesión no válida', 401);
  const stores = await withDatabase(env, async (client) => {
    const result = await client.query<{ id: string; code: string; name: string; aliases: string[] }>(
      'SELECT id, code, name, aliases FROM stores WHERE active = TRUE ORDER BY name ASC',
    );
    return result.rows;
  });
  return json({ success: true, stores });
}

async function loadOwnedReceipt(
  client: DbClient,
  receiptId: string,
  session: SessionRow,
  lock = false,
): Promise<ReceiptRow | null> {
  const result = await client.query<ReceiptRow>(
    `SELECT * FROM receipts WHERE id = $1 AND session_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [receiptId, session.id],
  );
  return result.rows[0] ?? null;
}

async function handleReceiptStatus(request: Request, env: Env, receiptId: string): Promise<Response> {
  return withDatabase(env, async (client) => {
    const session = await authenticatedSession(request, env, client);
    if (!session) return error('Sesión no válida', 401);
    const receipt = await loadOwnedReceipt(client, receiptId, session);
    if (!receipt) return error('Ticket no encontrado', 404);
    return json({ success: true, receipt: receiptView(receipt), session: sessionView(session) });
  });
}

function receiptFields(body: Record<string, unknown>): ReceiptFields {
  const totalCents = Number(body.totalCents);
  return {
    storeId: String(body.storeId || '').trim(),
    storeName: String(body.storeName || '').trim().slice(0, 160),
    ticketNumber: String(body.ticketNumber || '').trim().slice(0, 120),
    purchaseDate: String(body.purchaseDate || '').trim(),
    totalCents: Number.isInteger(totalCents) ? totalCents : 0,
    currency: String(body.currency || 'EUR').trim().toUpperCase().slice(0, 3),
  };
}

async function handleConfirm(request: Request, env: Env, receiptId: string): Promise<Response> {
  const body = await readJson(request);
  const fields = receiptFields(body);
  let outboxId = '';
  const result = await withDatabase(env, async (client) =>
    inTransaction(client, async () => {
      const session = await authenticatedSession(request, env, client);
      if (!session) return { response: error('Sesión no válida', 401) };
      const receipt = await loadOwnedReceipt(client, receiptId, session, true);
      if (!receipt) return { response: error('Ticket no encontrado', 404) };
      if (receipt.status !== 'READY_FOR_CONFIRMATION') {
        return { response: error('El ticket no está listo para confirmar', 409) };
      }

      const store = fields.storeId
        ? await client.query<{ id: string; active: boolean; name: string }>(
            'SELECT id, active, name FROM stores WHERE id = $1 LIMIT 1',
            [fields.storeId],
          )
        : { rows: [] };
      const selectedStore = store.rows[0];
      const fingerprint = buildTicketFingerprint(fields);
      const duplicate = await client.query(
        `SELECT id FROM receipts
          WHERE user_ref = $1 AND ticket_fingerprint = $2 AND id <> $3
            AND status = ANY($4::text[])
          LIMIT 1`,
        [session.user_ref, fingerprint, receiptId, [...ACTIVE_DUPLICATE_STATUSES]],
      );
      const validation = validateReceiptAutomatically({
        fields,
        ocr: receipt.ocr_payload || { isReceipt: false, confidence: 0 },
        storeActive: selectedStore?.active === true,
        duplicate: Boolean(duplicate.rowCount),
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
            fields.purchaseDate || null, fields.totalCents, fields.currency, fingerprint,
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
        `UPDATE receipts SET status = 'REWARD_PENDING', store_id = $2, store_name = $3,
           ticket_number = $4, purchase_date = $5, total_cents = $6, currency = $7,
           ticket_fingerprint = $8, risk_score = $9, validation_reasons = '[]'::jsonb,
           points_awarded = $10, updated_at = NOW()
         WHERE id = $1`,
        [receiptId, selectedStore!.id, selectedStore!.name, fields.ticketNumber,
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
  if (outboxId) await env.JOBS.send({ kind: 'DELIVER_REWARD', outboxId });
  return result.response;
}

async function processOcr(env: Env, receiptId: string): Promise<void> {
  const receipt = await withDatabase(env, async (client) => {
    const result = await client.query<Pick<ReceiptRow, 'id' | 'image_key' | 'image_content_type' | 'status'>>(
      `UPDATE receipts SET status = 'OCR_PROCESSING', updated_at = NOW()
        WHERE id = $1 AND status IN ('OCR_QUEUED', 'OCR_PROCESSING')
        RETURNING id, image_key, image_content_type, status`,
      [receiptId],
    );
    return result.rows[0];
  });
  if (!receipt) return;
  const image = await env.TICKETS.get(receipt.image_key);
  if (!image) throw new Error('R2_OBJECT_NOT_FOUND');
  const ocr = await readReceipt(env, await image.arrayBuffer(), receipt.image_content_type);
  await withDatabase(env, async (client) => {
    await client.query(
      `UPDATE receipts SET status = $2, store_name = $3, ticket_number = $4,
         purchase_date = $5, total_cents = $6, currency = $7,
         ocr_payload = $8::jsonb, ocr_confidence = $9, updated_at = NOW()
       WHERE id = $1`,
      [receiptId, ocr.isReceipt ? 'READY_FOR_CONFIRMATION' : 'NOT_A_RECEIPT',
        ocr.storeName || null, ocr.ticketNumber || null, ocr.purchaseDate || null,
        ocr.totalCents || null, ocr.currency || 'EUR', JSON.stringify(ocr), ocr.confidence],
    );
  });
}

async function markOcrFailed(env: Env, receiptId: string): Promise<void> {
  await withDatabase(env, async (client) => {
    await client.query(
      `UPDATE receipts SET status = 'OCR_FAILED', validation_reasons = $2::jsonb,
          updated_at = NOW() WHERE id = $1 AND status = 'OCR_PROCESSING'`,
      [receiptId, JSON.stringify(['OCR_PROCESSING_FAILED'])],
    );
  });
}

async function processOutbox(env: Env, outboxId: string): Promise<void> {
  const claimed = await withDatabase(env, async (client) =>
    inTransaction(client, async () => {
      const result = await client.query<{
        id: string; receipt_id: string; operation: 'GRANT' | 'REVOKE';
        idempotency_key: string; payload: Record<string, unknown>;
      }>(
        `SELECT id, receipt_id, operation, idempotency_key, payload
           FROM reward_outbox
          WHERE id = $1 AND next_attempt_at <= NOW()
            AND (status = 'PENDING' OR (status = 'PROCESSING' AND locked_until < NOW()))
          FOR UPDATE`,
        [outboxId],
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        `UPDATE reward_outbox SET status = 'PROCESSING', attempt_count = attempt_count + 1,
           locked_until = NOW() + INTERVAL '45 seconds', updated_at = NOW() WHERE id = $1`,
        [outboxId],
      );
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
  if (!claimed?.receipt) return;

  const { outbox, receipt } = claimed;
  const delivery = outbox.operation === 'GRANT'
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

  if (!delivery.response.ok || !delivery.payload.success) {
    const retryable = delivery.response.status >= 500 || [408, 425, 429].includes(delivery.response.status);
    await withDatabase(env, (client) => client.query(
      `UPDATE reward_outbox SET status = $2, last_error = $3,
         next_attempt_at = NOW() + (LEAST(3600, POWER(2, attempt_count) * 5)::text || ' seconds')::interval,
         locked_until = NULL, updated_at = NOW() WHERE id = $1`,
      [outboxId, retryable ? 'PENDING' : 'FAILED', String(delivery.payload.error || `HTTP_${delivery.response.status}`).slice(0, 500)],
    ).then(() => undefined));
    if (retryable) throw new Error('RTALES_RETRYABLE_DELIVERY');
    await withDatabase(env, (client) => client.query(
      `UPDATE receipts SET status = $2, updated_at = NOW() WHERE id = $1`,
      [receipt.id, outbox.operation === 'GRANT' ? 'REWARD_FAILED' : 'REWARDED'],
    ).then(() => undefined));
    return;
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
}

function adminFilters(url: URL) {
  const values: unknown[] = [];
  const conditions: string[] = ['1 = 1'];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    conditions.push(sql.replace('?', `$${values.length}`));
  };
  if (url.searchParams.get('user')) {
    const value = `%${url.searchParams.get('user')}%`;
    values.push(value);
    const subjectPlaceholder = `$${values.length}`;
    values.push(value);
    const displayNamePlaceholder = `$${values.length}`;
    values.push(value);
    const emailPlaceholder = `$${values.length}`;
    conditions.push(`(r.user_ref ILIKE ${subjectPlaceholder} OR s.display_name ILIKE ${displayNamePlaceholder} OR s.user_email ILIKE ${emailPlaceholder})`);
  }
  if (url.searchParams.get('store')) add('r.store_name ILIKE ?', `%${url.searchParams.get('store')}%`);
  if (url.searchParams.get('status')) add('r.status = ?', url.searchParams.get('status'));
  if (url.searchParams.get('review')) add('r.review_status = ?', url.searchParams.get('review'));
  if (url.searchParams.get('from')) add('r.purchase_date >= ?', url.searchParams.get('from'));
  if (url.searchParams.get('to')) add('r.purchase_date <= ?', url.searchParams.get('to'));
  return { where: conditions.join(' AND '), values };
}

async function adminRows(env: Env, url: URL): Promise<ReceiptRow[]> {
  const filters = adminFilters(url);
  return withDatabase(env, async (client) => {
    const result = await client.query<ReceiptRow>(
      `SELECT r.*, s.display_name AS user_display_name, s.user_email
         FROM receipts r JOIN player_sessions s ON s.id = r.session_id
        WHERE ${filters.where}
        ORDER BY r.created_at DESC LIMIT 1000`,
      filters.values,
    );
    return result.rows;
  });
}

async function handleAdminList(request: Request, env: Env): Promise<Response> {
  const manager = managerIdentity(request, env);
  if (!manager) return error('Acceso de gestor requerido', 401);
  const rows = await adminRows(env, new URL(request.url));
  return json({ success: true, manager, receipts: rows.map((row) => receiptView(row, true)) });
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

async function handleAdminCsv(request: Request, env: Env): Promise<Response> {
  if (!managerIdentity(request, env)) return error('Acceso de gestor requerido', 401);
  const rows = await adminRows(env, new URL(request.url));
  const header = ['ID', 'Usuario', 'Correo', 'Referencia usuario', 'Estado', 'Revisión', 'Tienda', 'Número', 'Fecha compra', 'Importe', 'Moneda', 'Puntos', 'Riesgo', 'Creado'];
  const lines = rows.map((row) => [row.public_id, row.user_display_name, row.user_email, row.user_ref, row.status, row.review_status, row.store_name,
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
  if (!['CLEAR', 'REVOKE'].includes(action)) return error('Acción no válida', 400);
  let outboxId = '';
  const response = await withDatabase(env, (client) => inTransaction(client, async () => {
    const result = await client.query<ReceiptRow>('SELECT * FROM receipts WHERE id = $1 FOR UPDATE', [receiptId]);
    const receipt = result.rows[0];
    if (!receipt) return error('Ticket no encontrado', 404);
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
    return json({ success: true, status: 'REVOKE_PENDING' }, 202);
  }));
  if (outboxId) await env.JOBS.send({ kind: 'DELIVER_REWARD', outboxId });
  return response;
}

function storeView(row: StoreRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    active: row.active,
    receiptCount: Number(row.receipt_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (env.ADMIN_ONLY === 'true') {
      if (url.pathname === '/') return Response.redirect(`${url.origin}/backoffice`, 302);
      const adminAsset = ['/backoffice', '/backoffice.html', '/backoffice.js', '/styles.css', '/favicon.ico'].includes(url.pathname);
      if (!adminAsset && !url.pathname.startsWith('/api/admin/')) return error('Ruta no encontrada', 404);
    } else if (url.pathname.startsWith('/api/admin/')) {
      return error('Ruta no encontrada', 404);
    }
    if (request.method === 'POST' && url.pathname === '/api/session/exchange') return await handleExchange(request, env);
    if (request.method === 'GET' && url.pathname === '/api/stores') return await handleStores(request, env);
    if (request.method === 'POST' && url.pathname === '/api/receipts') return await handleUpload(request, env);
    const receiptMatch = url.pathname.match(/^\/api\/receipts\/([^/]+)$/);
    if (request.method === 'GET' && receiptMatch?.[1]) return await handleReceiptStatus(request, env, receiptMatch[1]);
    const confirmMatch = url.pathname.match(/^\/api\/receipts\/([^/]+)\/confirm$/);
    if (request.method === 'POST' && confirmMatch?.[1]) return await handleConfirm(request, env, confirmMatch[1]);
    if (request.method === 'GET' && url.pathname === '/api/admin/receipts') return await handleAdminList(request, env);
    if (request.method === 'GET' && url.pathname === '/api/admin/receipts.csv') return await handleAdminCsv(request, env);
    if (url.pathname === '/api/admin/stores' && ['GET', 'POST'].includes(request.method)) {
      return await handleAdminStores(request, env);
    }
    const storeMatch = url.pathname.match(/^\/api\/admin\/stores\/([^/]+)$/);
    if (request.method === 'PATCH' && storeMatch?.[1]) return await handleAdminStoreUpdate(request, env, storeMatch[1]);
    if (url.pathname === '/api/admin/reward-tiers' && ['GET', 'POST'].includes(request.method)) {
      return await handleAdminRewardTiers(request, env);
    }
    const tierMatch = url.pathname.match(/^\/api\/admin\/reward-tiers\/([^/]+)$/);
    if (request.method === 'PATCH' && tierMatch?.[1]) return await handleAdminRewardTierUpdate(request, env, tierMatch[1]);
    const imageMatch = url.pathname.match(/^\/api\/admin\/receipts\/([^/]+)\/image$/);
    if (request.method === 'GET' && imageMatch?.[1]) return await handleAdminImage(request, env, imageMatch[1]);
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
        400: { message: 'El código de acceso a Rtales no es válido', code: 'RTALES_LAUNCH_INVALID' },
        401: { message: 'La conexión con Rtales no está configurada correctamente', code: 'RTALES_CONFIGURATION_ERROR' },
        403: { message: 'La conexión con Rtales no tiene los permisos necesarios', code: 'RTALES_CONFIGURATION_ERROR' },
        404: { message: 'La sesión de Rtales ya no está disponible', code: 'RTALES_LAUNCH_UNAVAILABLE' },
        409: { message: 'El código de acceso ya se ha utilizado', code: 'RTALES_LAUNCH_CONFLICT' },
        410: { message: 'La sesión de acceso ha caducado', code: 'RTALES_LAUNCH_EXPIRED' },
        429: { message: 'Rtales está recibiendo demasiadas solicitudes', code: 'RTALES_RATE_LIMITED' },
      };
      const mapped = rtalesErrors[status] || (status >= 500
        ? { message: 'Rtales no está disponible temporalmente', code: 'RTALES_UNAVAILABLE' }
        : { message: 'Rtales no pudo iniciar la sesión del jugador', code: 'RTALES_EXCHANGE_FAILED' });
      return error(mapped.message, status, mapped.code);
    }
    const message = caught instanceof Error ? caught.message : 'UNKNOWN_ERROR';
    const validationErrors: Record<string, string> = {
      INVALID_JSON: 'JSON no válido',
      STORE_CODE_INVALID: 'El código debe tener entre 2 y 40 caracteres: letras, números, guion o guion bajo',
      STORE_NAME_INVALID: 'El nombre debe tener entre 2 y 160 caracteres',
      STORE_ALIAS_INVALID: 'Los alias no pueden superar 160 caracteres',
      TIER_MINIMUM_INVALID: 'El importe mínimo debe ser un valor válido en céntimos',
      TIER_POINTS_INVALID: 'Los puntos deben ser un número entero positivo o cero',
    };
    return error(validationErrors[message] || 'No se pudo completar la operación', validationErrors[message] ? 400 : 500);
  }
}

async function requeueDueOutbox(env: Env): Promise<void> {
  const ids = await withDatabase(env, async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE reward_outbox SET status = 'PENDING', locked_until = NULL, updated_at = NOW()
        WHERE status = 'PROCESSING' AND locked_until < NOW()
        RETURNING id`,
    );
    const due = await client.query<{ id: string }>(
      `SELECT id FROM reward_outbox WHERE status = 'PENDING' AND next_attempt_at <= NOW() LIMIT 100`,
    );
    return Array.from(new Set([...result.rows, ...due.rows].map((row) => row.id)));
  });
  await Promise.all(ids.map((outboxId) => env.JOBS.send({ kind: 'DELIVER_REWARD', outboxId })));
}

export default {
  fetch: handleFetch,
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (message.body.kind === 'OCR_RECEIPT') await processOcr(env, message.body.receiptId);
        else await processOutbox(env, message.body.outboxId);
        message.ack();
      } catch (caught) {
        console.error('Queue job failed', message.body, caught);
        if (message.body.kind === 'OCR_RECEIPT' && message.attempts >= 8) {
          await markOcrFailed(env, message.body.receiptId);
          message.ack();
        } else {
          message.retry();
        }
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(requeueDueOutbox(env));
  },
} satisfies ExportedHandler<Env, JobMessage>;
