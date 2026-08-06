export type AppSettingFormat = 'plain' | 'rich';

export type AppSettingDefinition = {
  key: string;
  group: string;
  label: string;
  help: string;
  format: AppSettingFormat;
  defaultValue: string;
  maxLength: number;
};

export const APP_SETTING_DEFINITIONS: readonly AppSettingDefinition[] = [
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
  return definition.format === 'plain' ? normalized.trim() : normalized;
}
