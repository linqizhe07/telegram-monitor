import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicLlm, LlmError } from '../src/llm.ts';
import { SYSTEM_PROMPT } from '../src/prompts.ts';
import { JudgeSchema } from '../src/schema.ts';

/** A fetch that records the request and answers with a streamed Messages API response. */
function streamingFetch(text: string, stopReason = 'end_turn', extra: Record<string, unknown> = {}) {
  const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, ...extra }, usage: { output_tokens: 500 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    const sse = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } });
  };
  return { seen, fetchImpl };
}

const verdict = { winner: 'B', confidence: 'high', reasons: 'B covers the bridge exploit.', a_weaknesses: ['misses the exploit'], b_weaknesses: [] };
const request = { role: 'judge' as const, context: '<transcript>…</transcript>', instructions: '<task>judge</task>', schema: JudgeSchema, effort: 'high' as const };

test('the request: streaming, adaptive thinking, structured output, fallbacks, cached transcript', async () => {
  const { seen, fetchImpl } = streamingFetch(JSON.stringify(verdict));
  const client = new Anthropic({ apiKey: 'test-key', fetch: fetchImpl as typeof fetch, maxRetries: 0 });
  const llm = new AnthropicLlm({ model: 'claude-opus-5-5', client });
  const { data, usage } = await llm.json(request);

  assert.deepEqual(data, verdict);
  assert.equal(usage.inputTokens, 1000);
  assert.equal(usage.outputTokens, 500);
  assert.equal(usage.cacheRead, 9000);
  assert.ok(Math.abs(usage.costUsd! - (1000 * 4 + 500 * 20 + 9000 * 0.2) / 1e6) < 1e-12);

  const [{ url, headers, body }] = seen;
  assert.match(url, /\/v1\/messages\?beta=true$/);
  const betas = headers.get('anthropic-beta') ?? '';
  assert.ok(betas.includes('structured-outputs-2025-12-15') && betas.includes('server-side-fallback-2026-07-01'), betas);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.stream, true);
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  const output = body.output_config as { effort: string; format: { type: string; schema: { properties: Record<string, unknown> } } };
  assert.equal(output.effort, 'high');
  assert.equal(output.format.type, 'json_schema');
  assert.deepEqual(Object.keys(output.format.schema.properties).sort(), ['a_weaknesses', 'b_weaknesses', 'confidence', 'reasons', 'winner']);
  assert.equal(body.system, SYSTEM_PROMPT);
  const [message] = body.messages as { role: string; content: { type: string; text: string; cache_control?: unknown }[] }[];
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content[0], { type: 'text', text: '<transcript>…</transcript>', cache_control: { type: 'ephemeral' } });
  assert.deepEqual(message.content[1], { type: 'text', text: '<task>judge</task>' });
  assert.equal(body.betas, undefined, 'betas travel as a header, not in the body');
});

test('a refusal, a truncated answer and an answer that does not fit the schema are errors, not data', async () => {
  const cases: [string, string, LlmError['kind']][] = [
    ['', 'refusal', 'refusal'],
    ['{"winner": "B", "confid', 'max_tokens', 'truncated'],
    [JSON.stringify({ ...verdict, winner: 'C' }), 'end_turn', 'invalid'],
  ];
  for (const [text, stop, kind] of cases) {
    const { fetchImpl } = streamingFetch(text, stop);
    const client = new Anthropic({ apiKey: 'test-key', fetch: fetchImpl as typeof fetch, maxRetries: 0 });
    const llm = new AnthropicLlm({ model: 'claude-opus-5-5', client, });
    await assert.rejects(llm.json(request), (err: unknown) => err instanceof LlmError && err.kind === kind, `${stop} → ${kind}`);
  }
});
