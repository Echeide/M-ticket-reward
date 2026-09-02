import type { Env } from '../types';

export type QueryResult<T> = {
  rows: T[];
  rowCount: number;
};

export type DbClient = {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
};

const JSON_COLUMNS = new Set([
  'aliases',
  'actual_payload',
  'changes',
  'cards_awarded',
  'collection_config',
  'context',
  'evaluation_actual_payload',
  'evaluation_context',
  'evaluation_matches',
  'evaluation_verification_issues',
  'matches',
  'ocr_payload',
  'ocr_profile',
  'payload',
  'product_terms',
  'response_payload',
  'validation_reasons',
  'verification_issues',
  'awarded_card_ids',
]);

const BOOLEAN_COLUMNS = new Set(['active']);

function normalizeRow<T>(row: Record<string, unknown>): T {
  const normalized: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(normalized)) {
    if (JSON_COLUMNS.has(key) && typeof value === 'string') {
      try {
        normalized[key] = JSON.parse(value);
      } catch {
        // Preserve malformed legacy data so the caller can handle it explicitly.
      }
    }
    if (BOOLEAN_COLUMNS.has(key) && typeof value === 'number') {
      normalized[key] = value === 1;
    }
  }
  return normalized as T;
}

function sqliteValue(value: unknown): string | number | null | ArrayBuffer {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || typeof value === 'string' || typeof value === 'number' || value instanceof ArrayBuffer) {
    return value;
  }
  return JSON.stringify(value);
}

export function compilePostgresQuery(sql: string, values: unknown[]) {
  let statement = sql
    .replace(/FOR\s+UPDATE/gi, '')
    .replace(/\bILIKE\b/gi, 'LIKE')
    .replace(/COUNT\(([^)]+)\)::text/gi, 'COUNT($1)')
    .replace(/::jsonb\b/gi, '')
    .replace(/::text(?!\[\])/gi, '')
    .replace(/NOW\(\)\s*\+\s*INTERVAL\s*'24 hours'/gi, "datetime('now', '+24 hours')")
    .replace(/NOW\(\)\s*\+\s*INTERVAL\s*'45 seconds'/gi, "datetime('now', '+45 seconds')")
    .replace(
      /NOW\(\)\s*\+\s*\(LEAST\(3600,\s*POWER\(2,\s*attempt_count\)\s*\*\s*5\)\s*\|\|\s*' seconds'\)::interval/gi,
      "datetime('now', '+' || MIN(3600, CAST(POWER(2, attempt_count) * 5 AS INTEGER)) || ' seconds')",
    )
    .replace(/NOW\(\)/gi, 'CURRENT_TIMESTAMP');

  const bindings: Array<string | number | null | ArrayBuffer> = [];
  statement = statement.replace(
    /=\s*ANY\(\$(\d+)::text\[\]\)|\$(\d+)/gi,
    (_match, arrayIndexText: string | undefined, scalarIndexText: string | undefined) => {
      if (arrayIndexText) {
        const value = values[Number(arrayIndexText) - 1];
        const items = Array.isArray(value) ? value : [];
        if (!items.length) return 'IN (NULL)';
        bindings.push(...items.map(sqliteValue));
        return `IN (${items.map(() => '?').join(', ')})`;
      }
      bindings.push(sqliteValue(values[Number(scalarIndexText) - 1]));
      return '?';
    },
  );
  return { statement, bindings };
}

function createClient(database: D1Database): DbClient {
  return {
    async query<T>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
      const { statement, bindings } = compilePostgresQuery(sql, values);
      const result = await database.prepare(statement).bind(...bindings).all<Record<string, unknown>>();
      if (!result.success) throw new Error(result.error || 'D1_QUERY_FAILED');
      const rows = (result.results || []).map((row) => normalizeRow<T>(row));
      return {
        rows,
        rowCount: rows.length || Number(result.meta?.changes ?? 0),
      };
    },
  };
}

export async function withDatabase<T>(
  env: Env,
  operation: (client: DbClient) => Promise<T>,
): Promise<T> {
  return operation(createClient(env.DB));
}

// D1 executes each statement atomically. Cross-statement integrity is additionally
// protected by unique indexes, conditional state transitions and Rtales idempotency.
export async function inTransaction<T>(
  _client: DbClient,
  operation: () => Promise<T>,
): Promise<T> {
  return operation();
}
