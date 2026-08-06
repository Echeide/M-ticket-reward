export const PENDING_CONFIGURATION_VALUE = '__PENDING_CONFIGURATION__';

export function isConfiguredEnvValue(value?: string): value is string {
  const normalized = value?.trim();
  return Boolean(normalized && normalized !== PENDING_CONFIGURATION_VALUE);
}
