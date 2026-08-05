import type { Env } from '../types';

const MAX_WIDTH = 2000;
const MAX_HEIGHT = 3200;
const TARGET_QUALITY = 82;
const FALLBACK_QUALITY = 68;
const TARGET_MAX_BYTES = 3 * 1024 * 1024;

export type StoredImage = {
  bytes: ArrayBuffer;
  contentType: string;
  extension: 'jpg' | 'png' | 'webp';
  originalBytes: number;
  width: number;
  height: number;
};

function extension(contentType: string): StoredImage['extension'] {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  return 'jpg';
}

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

  let optimized = await transform(env, original, TARGET_QUALITY);
  if (optimized.byteLength > TARGET_MAX_BYTES) {
    optimized = await transform(env, original, FALLBACK_QUALITY);
  }

  if (optimized.byteLength >= original.byteLength) {
    return {
      bytes: original,
      contentType: originalContentType,
      extension: extension(originalContentType),
      originalBytes: original.byteLength,
      width: info.width,
      height: info.height,
    };
  }

  return {
    bytes: optimized,
    contentType: 'image/webp',
    extension: 'webp',
    originalBytes: original.byteLength,
    width: info.width,
    height: info.height,
  };
}

export async function prepareOcrImage(env: Env, image: ArrayBuffer): Promise<ArrayBuffer> {
  const result = await env.IMAGES
    .input(new Blob([image]).stream())
    .transform({ width: 1200, height: 2000, fit: 'scale-down', sharpen: 1 })
    .output({ format: 'image/webp', quality: 70 });
  return result.response().arrayBuffer();
}
