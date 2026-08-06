import assert from 'node:assert/strict';
import test from 'node:test';
import { optimizeStoreLogo } from '../src/platform/image';
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
