export type AppSettingFormat = 'plain' | 'rich' | 'datetime' | 'integer' | 'boolean';

export type AppSettingDefinition = {
  key: string;
  group: string;
  label: string;
  help: string;
  format: AppSettingFormat;
  defaultValue: string;
  maxLength: number;
  minimum?: number;
  maximum?: number;
  adminOnly?: boolean;
};

export const APP_SETTING_DEFINITIONS: readonly AppSettingDefinition[] = [
  {
    key: 'scan.assisted.enabled',
    group: 'Flujo de escaneo',
    label: 'Solicitar datos antes de fotografiar',
    help: 'Muestra al usuario el formulario de número de documento e importe antes de abrir la cámara.',
    format: 'boolean',
    defaultValue: 'true',
    maxLength: 5,
    adminOnly: true,
  },
  {
    key: 'scan.assisted.requireStore',
    group: 'Flujo de escaneo',
    label: 'Solicitar establecimiento',
    help: 'Añade al formulario previo un selector obligatorio con los comercios autorizados.',
    format: 'boolean',
    defaultValue: 'true',
    maxLength: 5,
    adminOnly: true,
  },
  {
    key: 'validation.startAt',
    group: 'Validación de tickets',
    label: 'Inicio del periodo válido',
    help: 'Si se define, no se autorizarán tickets anteriores a esta fecha y hora (horario de Canarias).',
    format: 'datetime',
    defaultValue: '',
    maxLength: 16,
  },
  {
    key: 'validation.endAt',
    group: 'Validación de tickets',
    label: 'Fin del periodo válido',
    help: 'Si se define, no se autorizarán tickets posteriores a esta fecha y hora (horario de Canarias).',
    format: 'datetime',
    defaultValue: '',
    maxLength: 16,
  },
  {
    key: 'limits.dailyTicketsPerUserStore',
    group: 'Límites de participación',
    label: 'Tickets diarios por usuario y establecimiento',
    help: 'Máximo de tickets válidos por día para un usuario en un mismo establecimiento. Usa 0 para desactivarlo.',
    format: 'integer',
    defaultValue: '3',
    maxLength: 5,
    minimum: 0,
    maximum: 100,
  },
  {
    key: 'limits.totalPointsPerUser',
    group: 'Límites de participación',
    label: 'Puntos máximos por usuario durante la campaña',
    help: 'Máximo de puntos que puede obtener un usuario durante el periodo de campaña actual. Usa 0 para desactivarlo.',
    format: 'integer',
    defaultValue: '0',
    maxLength: 8,
    minimum: 0,
    maximum: 10_000_000,
  },
  {
    key: 'limits.banScoreThreshold',
    group: 'Límites de participación',
    label: 'Puntos de infracción para banear',
    help: 'El usuario será baneado al alcanzar esta puntuación. Usa 0 para desactivar nuevos baneos automáticos.',
    format: 'integer',
    defaultValue: '6',
    maxLength: 3,
    minimum: 0,
    maximum: 100,
  },
  {
    key: 'home.eyebrow',
    group: 'Portada',
    label: 'Antetítulo de portada',
    help: 'Texto pequeño que aparece sobre el título principal.',
    format: 'plain',
    defaultValue: 'Premios por tus compras',
    maxLength: 160,
  },
  {
    key: 'home.title',
    group: 'Portada',
    label: 'Título principal de portada',
    help: 'Mensaje principal que recibe al usuario.',
    format: 'plain',
    defaultValue: 'Escanea tus tickets y gana puntos',
    maxLength: 240,
  },
  {
    key: 'home.description',
    group: 'Portada',
    label: 'Descripción de portada',
    help: 'Admite negrita y enlaces con el formato indicado en el editor.',
    format: 'rich',
    defaultValue: 'Escanea los tickets de compra en las tiendas asociadas y gana puntos para canjear en nuestro catálogo de regalos.',
    maxLength: 4_000,
  },
  {
    key: 'home.carouselLabel',
    group: 'Portada',
    label: 'Texto sobre los comercios',
    help: 'Etiqueta centrada que acompaña al carrusel de logotipos.',
    format: 'plain',
    defaultValue: 'Disponible en comercios asociados',
    maxLength: 200,
  },
  {
    key: 'home.scanButton',
    group: 'Portada',
    label: 'Botón para escanear',
    help: 'Texto del botón principal de la portada.',
    format: 'plain',
    defaultValue: 'Escanear ticket',
    maxLength: 100,
  },
  {
    key: 'home.historyButton',
    group: 'Portada',
    label: 'Botón de tickets',
    help: 'Texto del botón que abre el historial del usuario.',
    format: 'plain',
    defaultValue: 'Mis tickets',
    maxLength: 100,
  },
  {
    key: 'home.privacyNote',
    group: 'Portada',
    label: 'Nota inferior de portada',
    help: 'Admite negrita y enlaces con el formato indicado en el editor.',
    format: 'rich',
    defaultValue: 'La imagen se almacena de forma privada y puede ser revisada para prevenir fraude.',
    maxLength: 4_000,
  },
];

export function appSettingsWithDefaults(rows: Array<{ key: string; value: string }>): Record<string, string> {
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  return Object.fromEntries(APP_SETTING_DEFINITIONS.map((definition) => [
    definition.key,
    stored.get(definition.key) ?? definition.defaultValue,
  ]));
}

export function settingDefinition(key: string): AppSettingDefinition {
  const definition = APP_SETTING_DEFINITIONS.find((item) => item.key === key);
  if (!definition) throw new Error('APP_SETTING_UNKNOWN');
  return definition;
}

export function normalizeAppSettingValue(key: string, value: unknown): string {
  const definition = settingDefinition(key);
  if (typeof value !== 'string') throw new Error('APP_SETTING_VALUE_INVALID');
  const normalized = value.replace(/\r\n?/g, '\n');
  if (normalized.length > definition.maxLength) throw new Error('APP_SETTING_TOO_LONG');
  if (definition.format === 'integer') {
    if (!/^\d+$/.test(normalized)) throw new Error('APP_SETTING_INTEGER_INVALID');
    const number = Number(normalized);
    if (!Number.isSafeInteger(number) || number < (definition.minimum ?? 0) || number > (definition.maximum ?? Number.MAX_SAFE_INTEGER)) {
      throw new Error('APP_SETTING_INTEGER_INVALID');
    }
    return String(number);
  }
  if (definition.format === 'boolean') {
    if (normalized !== 'true' && normalized !== 'false') throw new Error('APP_SETTING_BOOLEAN_INVALID');
    return normalized;
  }
  if (definition.format === 'datetime' && normalized) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(normalized);
    if (!match) throw new Error('APP_SETTING_DATETIME_INVALID');
    const date = new Date(Date.UTC(
      Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]),
    ));
    if (
      date.getUTCFullYear() !== Number(match[1]) ||
      date.getUTCMonth() !== Number(match[2]) - 1 ||
      date.getUTCDate() !== Number(match[3]) ||
      date.getUTCHours() !== Number(match[4]) ||
      date.getUTCMinutes() !== Number(match[5])
    ) throw new Error('APP_SETTING_DATETIME_INVALID');
  }
  return definition.format === 'plain' ? normalized.trim() : normalized;
}

export function booleanAppSetting(settings: Record<string, string>, key: string): boolean {
  const definition = settingDefinition(key);
  const value = settings[key] ?? definition.defaultValue;
  return value === 'true';
}

export function numericAppSetting(settings: Record<string, string>, key: string): number {
  const definition = settingDefinition(key);
  const value = Number(settings[key] ?? definition.defaultValue);
  return Number.isSafeInteger(value) ? value : Number(definition.defaultValue);
}

export function validateAppSettingPeriod(settings: Record<string, string>): void {
  const startAt = settings['validation.startAt'] || '';
  const endAt = settings['validation.endAt'] || '';
  if (startAt && endAt && startAt > endAt) throw new Error('APP_SETTING_PERIOD_INVALID');
}
