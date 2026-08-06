import type { Env } from '../types';

export type OcrProviderRequest = {
  bytes: ArrayBuffer;
  contentType: string;
  prompt: string;
};

export type OcrProviderResponse = {
  text: string;
  provider: string;
  model: string;
  durationMs: number;
};

export interface OcrProvider {
  extract(request: OcrProviderRequest): Promise<OcrProviderResponse>;
}

function dataUrl(bytes: ArrayBuffer, contentType: string): string {
  const values = new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    binary += String.fromCharCode(...values.subarray(offset, offset + chunkSize));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

function timeoutMs(env: Env): number {
  const configured = Number(env.OCR_TIMEOUT_MS);
  return Number.isFinite(configured) ? Math.max(5_000, Math.min(120_000, configured)) : 45_000;
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('OCR_PROVIDER_TIMEOUT')), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function textFromEventStream(value: string): Promise<string | null> {
  const dataLines = value.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]');
  if (!dataLines.length) return value.trim() || null;
  const chunks: string[] = [];
  for (const line of dataLines) {
    try {
      const text = await extractResponseText(JSON.parse(line));
      if (text) chunks.push(text);
    } catch {
      chunks.push(line);
    }
  }
  return chunks.join('') || null;
}

async function extractResponseText(payload: unknown): Promise<string | null> {
  if (typeof payload === 'string') return textFromEventStream(payload);
  if (payload instanceof Response) {
    const contentType = payload.headers.get('content-type') || '';
    if (contentType.includes('json')) return extractResponseText(await payload.json());
    return textFromEventStream(await payload.text());
  }
  if (payload instanceof ReadableStream) {
    return textFromEventStream(await new Response(payload).text());
  }
  if (Array.isArray(payload)) {
    const parts = await Promise.all(payload.map(extractResponseText));
    return parts.filter(Boolean).join('') || null;
  }
  if (!payload || typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  if (message?.content !== undefined) {
    const text = await extractResponseText(message.content);
    if (text) return text;
  }
  for (const key of ['answer', 'description', 'response', 'result', 'output', 'data']) {
    if (record[key] === undefined || record[key] === null) continue;
    const text = await extractResponseText(record[key]);
    if (text) return text;
  }
  return null;
}

export async function providerResponseText(payload: unknown): Promise<string> {
  const text = await extractResponseText(payload);
  if (!text) throw new Error('OCR_PROVIDER_EMPTY_RESPONSE');
  return text;
}

class WorkersAiOcrProvider implements OcrProvider {
  constructor(private readonly env: Env) {}

  async extract(request: OcrProviderRequest): Promise<OcrProviderResponse> {
    const startedAt = Date.now();
    const result = await withTimeout(
      (this.env.AI as unknown as { run: Function }).run(this.env.OCR_MODEL, {
        task: 'query',
        image: dataUrl(request.bytes, request.contentType),
        question: request.prompt,
        reasoning: false,
        stream: false,
        temperature: 0.1,
        max_tokens: 2_048,
      }) as Promise<Record<string, unknown>>,
      timeoutMs(this.env),
    );
    return {
      text: await providerResponseText(result),
      provider: 'workers-ai',
      model: this.env.OCR_MODEL,
      durationMs: Date.now() - startedAt,
    };
  }
}

class OpenAiCompatibleOcrProvider implements OcrProvider {
  constructor(private readonly env: Env) {}

  async extract(request: OcrProviderRequest): Promise<OcrProviderResponse> {
    const baseUrl = String(this.env.OCR_API_BASE_URL || '').trim().replace(/\/$/, '');
    const apiKey = String(this.env.OCR_API_KEY || '').trim();
    if (!baseUrl) throw new Error('OCR_API_BASE_URL_REQUIRED');
    if (!apiKey) throw new Error('OCR_API_KEY_REQUIRED');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('OCR_PROVIDER_TIMEOUT'), timeoutMs(this.env));
    const startedAt = Date.now();
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.env.OCR_MODEL,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: request.prompt },
              { type: 'image_url', image_url: { url: dataUrl(request.bytes, request.contentType) } },
            ],
          }],
          temperature: 0.1,
          max_tokens: 2_048,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OCR_PROVIDER_HTTP_${response.status}`);
      const payload = await response.json() as Record<string, unknown>;
      return {
        text: await providerResponseText(payload),
        provider: 'openai-compatible',
        model: this.env.OCR_MODEL,
        durationMs: Date.now() - startedAt,
      };
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        throw new Error('OCR_PROVIDER_TIMEOUT');
      }
      throw caught;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createOcrProvider(env: Env): OcrProvider {
  const provider = String(env.OCR_PROVIDER || 'workers-ai').trim().toLowerCase();
  if (provider === 'workers-ai') return new WorkersAiOcrProvider(env);
  if (provider === 'openai-compatible') return new OpenAiCompatibleOcrProvider(env);
  throw new Error(`OCR_PROVIDER_UNSUPPORTED:${provider}`);
}
