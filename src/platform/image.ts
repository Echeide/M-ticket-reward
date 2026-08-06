import type { Env } from '../types';

const MAX_WIDTH = 1200;
const MAX_HEIGHT = 2000;
const TARGET_QUALITY = 76;
const FALLBACK_QUALITY = 64;
const TARGET_MAX_BYTES = 2 * 1024 * 1024;

export type StoredImage = {
  bytes: ArrayBuffer;
  contentType: string;
  extension: 'jpg' | 'png' | 'webp';
  originalBytes: number;
  width: number;
  height: number;
  ocrReady: true;
};

export type StoredLogo = {
  bytes: ArrayBuffer;
  contentType: 'image/webp';
  extension: 'webp';
  originalBytes: number;
  width: number;
  height: number;
};

async function transform(env: Env, bytes: ArrayBuffer, quality: number): Promise<ArrayBuffer> {
  const result = await env.IMAGES
    .input(new Blob([bytes]).stream())
    .transform({ width: MAX_WIDTH, height: MAX_HEIGHT, fit: 'scale-down', sharpen: 1 })
    .output({ format: 'image/webp', quality });
  return result.response().arrayBuffer();
}

export async function optimizeTicketImage(
  env: Env,
  original: ArrayBuffer,
  originalContentType: string,
): Promise<StoredImage> {
  const info = await env.IMAGES.info(new Blob([original]).stream());
  if (!('width' in info) || info.format === 'image/svg+xml') throw new Error('IMAGE_INVALID');

  const scale = Math.min(1, MAX_WIDTH / info.width, MAX_HEIGHT / info.height);
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));
  const alreadyCanonical = originalContentType === 'image/webp' && info.format === 'image/webp' &&
    info.width <= MAX_WIDTH && info.height <= MAX_HEIGHT &&
    original.byteLength <= TARGET_MAX_BYTES;

  if (alreadyCanonical) {
    return {
      bytes: original,
      contentType: 'image/webp',
      extension: 'webp',
      originalBytes: original.byteLength,
      width: info.width,
      height: info.height,
      ocrReady: true,
    };
  }

  let optimized = await transform(env, original, TARGET_QUALITY);
  if (optimized.byteLength > TARGET_MAX_BYTES) {
    optimized = await transform(env, original, FALLBACK_QUALITY);
  }

  return {
    bytes: optimized,
    contentType: 'image/webp',
    extension: 'webp',
    originalBytes: original.byteLength,
    width,
    height,
    ocrReady: true,
  };
}

export async function optimizeStoreLogo(env: Env, original: ArrayBuffer): Promise<StoredLogo> {
  const info = await env.IMAGES.info(new Blob([original]).stream());
  if (!('width' in info) || info.format === 'image/svg+xml') throw new Error('IMAGE_INVALID');

  const scale = Math.min(1, 800 / info.width);
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));
  const result = await env.IMAGES
    .input(new Blob([original]).stream())
    .transform({ width: 800, fit: 'scale-down' })
    .output({ format: 'image/webp', quality: 82 });

  return {
    bytes: await result.response().arrayBuffer(),
    contentType: 'image/webp',
    extension: 'webp',
    originalBytes: original.byteLength,
    width,
    height,
  };
}

// Compatibility path for objects stored before canonical OCR images were used.
export async function prepareOcrImage(env: Env, image: ArrayBuffer): Promise<ArrayBuffer> {
  const result = await env.IMAGES
    .input(new Blob([image]).stream())
    .transform({ width: 1200, height: 2000, fit: 'scale-down', sharpen: 1 })
    .output({ format: 'image/webp', quality: 70 });
  return result.response().arrayBuffer();
}

export async function prepareOcrRegions(
  env: Env,
  image: ArrayBuffer,
): Promise<{ header: ArrayBuffer; totals: ArrayBuffer }> {
  const info = await env.IMAGES.info(new Blob([image]).stream());
  if (!('width' in info) || info.format === 'image/svg+xml') throw new Error('IMAGE_INVALID');
  const regionHeight = Math.max(1, Math.round(info.height * 0.68));
  const crop = async (gravity: 'top' | 'bottom') => {
    const result = await env.IMAGES
      .input(new Blob([image]).stream())
      .transform({ width: info.width, height: regionHeight, fit: 'cover', gravity, sharpen: 1 })
      .output({ format: 'image/webp', quality: 82 });
    return result.response().arrayBuffer();
  };
  const [header, totals] = await Promise.all([crop('top'), crop('bottom')]);
  return { header, totals };
}
