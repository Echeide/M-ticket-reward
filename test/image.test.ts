import assert from 'node:assert/strict';
import test from 'node:test';
import { optimizeStoreLogo, prepareOcrImageCandidates, prepareOcrRegions } from '../src/platform/image';
import type { Env } from '../src/types';

test('store logos are converted to WebP at a maximum width of 800 pixels', async () => {
  let transformOptions: unknown;
  let outputOptions: unknown;
  const transformer = {
    transform(options: unknown) {
      transformOptions = options;
      return transformer;
    },
    output(options: unknown) {
      outputOptions = options;
      return {
        response: () => new Response(new Uint8Array([1, 2, 3])),
      };
    },
  };
  const env = {
    IMAGES: {
      info: async () => ({ width: 1600, height: 400, format: 'image/png' }),
      input: () => transformer,
    },
  } as unknown as Env;

  const result = await optimizeStoreLogo(env, new Uint8Array([4, 5, 6, 7]).buffer);

  assert.deepEqual(transformOptions, { width: 800, fit: 'scale-down' });
  assert.deepEqual(outputOptions, { format: 'image/webp', quality: 82 });
  assert.equal(result.width, 800);
  assert.equal(result.height, 200);
  assert.equal(result.contentType, 'image/webp');
  assert.equal(result.bytes.byteLength, 3);
});

test('OCR fallback crops header and totals without rescaling the ticket width', async () => {
  const transforms: unknown[] = [];
  const transformer = {
    transform(options: unknown) {
      transforms.push(options);
      return transformer;
    },
    output() {
      return { response: () => new Response(new Uint8Array([1, 2, 3])) };
    },
  };
  const env = {
    IMAGES: {
      info: async () => ({ width: 1200, height: 1600, format: 'image/webp' }),
      input: () => transformer,
    },
  } as unknown as Env;

  const regions = await prepareOcrRegions(env, new Uint8Array([4, 5, 6]).buffer);

  assert.deepEqual(transforms, [
    { width: 1200, height: 928, fit: 'cover', gravity: 'top', sharpen: 1 },
    { width: 1200, height: 1088, fit: 'cover', gravity: 'bottom', sharpen: 1 },
  ]);
  assert.equal(regions.header.byteLength, 3);
  assert.equal(regions.totals.byteLength, 3);
});

test('landscape OCR images generate both possible upright rotations', async () => {
  const transforms: unknown[] = [];
  const transformer = {
    transform(options: unknown) {
      transforms.push(options);
      return transformer;
    },
    output() {
      return { response: () => new Response(new Uint8Array([1, 2, 3])) };
    },
  };
  const env = {
    IMAGES: {
      info: async () => ({ width: 1200, height: 900, format: 'image/webp' }),
      input: () => transformer,
    },
  } as unknown as Env;

  const candidates = await prepareOcrImageCandidates(
    env, new Uint8Array([4, 5, 6]).buffer, 'image/webp',
  );

  assert.deepEqual(transforms, [
    { rotate: 90, sharpen: 1 },
    { rotate: 270, sharpen: 1 },
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.rotation), [0, 90, 270]);
  assert.ok(candidates.every((candidate) => candidate.contentType === 'image/webp'));
});
