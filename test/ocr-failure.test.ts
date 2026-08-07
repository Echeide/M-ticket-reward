import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyOcrFailure,
  ocrErrorMessage,
  ocrMaxAttempts,
  ocrRetryDelaySeconds,
} from '../src/domain/ocr-failure';

test('OCR quota and configuration errors are terminal', () => {
  assert.deepEqual(classifyOcrFailure(new Error('AiError 3036: daily free allocation exceeded')), {
    error: 'Error: AiError 3036: daily free allocation exceeded',
    reason: 'OCR_PROVIDER_QUOTA_EXCEEDED',
    retryable: false,
  });
  assert.equal(classifyOcrFailure({ code: 5016, message: 'Model agreement required' }).retryable, false);
  assert.equal(classifyOcrFailure(new Error('Workers AI error 3006 request too large')).retryable, false);
  assert.equal(classifyOcrFailure(new Error('OCR_PROVIDER_CONFIGURATION_ERROR')).retryable, false);
});

test('OCR capacity, rate limit and timeout errors can be retried', () => {
  assert.equal(classifyOcrFailure(new Error('3040 out of capacity')).reason, 'OCR_PROVIDER_CAPACITY');
  assert.equal(classifyOcrFailure(new Error('HTTP 429 too many requests')).reason, 'OCR_PROVIDER_RATE_LIMITED');
  assert.equal(classifyOcrFailure(new Error('OCR_PROVIDER_TIMEOUT')).reason, 'OCR_PROVIDER_TIMEOUT');
  assert.equal(classifyOcrFailure(new Error('fetch failed')).retryable, true);
  assert.equal(classifyOcrFailure(new Error('Expected property name in JSON')).reason, 'OCR_INVALID_JSON');
});

test('OCR error telemetry is bounded and retry settings are conservative', () => {
  assert.equal(ocrErrorMessage(new Error('x'.repeat(2_000))).length, 1_000);
  assert.equal(ocrMaxAttempts(undefined), 3);
  assert.equal(ocrMaxAttempts('99'), 8);
  assert.equal(ocrMaxAttempts('0'), 1);
  assert.deepEqual([1, 2, 3, 8].map(ocrRetryDelaySeconds), [5, 15, 30, 30]);
});
