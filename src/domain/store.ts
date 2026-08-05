export type StoreInput = {
  code: string;
  name: string;
  aliases: string[];
  active: boolean;
};

export function normalizeStoreInput(value: Record<string, unknown>): StoreInput {
  const code = String(value.code || '').trim().toUpperCase();
  const name = String(value.name || '').trim();
  const rawAliases = Array.isArray(value.aliases)
    ? value.aliases
    : String(value.aliases || '').split(/[\n,]/);
  const aliases = Array.from(new Set(rawAliases
    .map((alias) => String(alias).trim())
    .filter(Boolean)))
    .slice(0, 30);

  if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code)) {
    throw new Error('STORE_CODE_INVALID');
  }
  if (name.length < 2 || name.length > 160) {
    throw new Error('STORE_NAME_INVALID');
  }
  if (aliases.some((alias) => alias.length > 160)) {
    throw new Error('STORE_ALIAS_INVALID');
  }

  return { code, name, aliases, active: value.active !== false };
}
