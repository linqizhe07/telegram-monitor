import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import type { Effort } from './config.ts';
import { SYSTEM_PROMPT } from './prompts.ts';

export type Role = 'digest' | 'merge' | 'critique' | 'judge' | 'improve' | 'calibrate';

export interface LlmRequest<T> {
  role: Role;
  /** Large shared prefix (usually the transcript). Sent first and cached, so calls over one window reuse it. */
  context: string;
  /** The role's task, after the context. */
  instructions: string;
  schema: z.ZodType<T>;
  effort: Effort;
  maxTokens?: number;
}

export interface LlmUsage {
  role: Role;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** Estimate from list prices; null for a model not in the table. */
  costUsd: number | null;
}

export interface Llm {
  readonly model: string;
  json<T>(req: LlmRequest<T>): Promise<{ data: T; usage: LlmUsage }>;
}

export class LlmError extends Error {
  readonly kind: 'refusal' | 'truncated' | 'invalid';
  readonly usage: LlmUsage | null;
  constructor(message: string, kind: LlmError['kind'], usage: LlmUsage | null) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.usage = usage;
  }
}

// USD per million tokens. Cache writes are the 5-minute TTL rate (1.25 × input).
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export function estimateCost(model: string, u: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
}

export class AnthropicLlm implements Llm {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: { model: string; client?: Anthropic }) {
    this.model = opts.model;
    // Credentials come from the environment (ANTHROPIC_API_KEY, or an `ant auth login` profile).
    this.client = opts.client ?? new Anthropic({ maxRetries: 4 });
  }

  async json<T>(req: LlmRequest<T>): Promise<{ data: T; usage: LlmUsage }> {
    const content: Anthropic.Beta.BetaTextBlockParam[] = [];
    if (req.context) content.push({ type: 'text', text: req.context, cache_control: { type: 'ephemeral' } });
    content.push({ type: 'text', text: req.instructions });

    // The schema goes to the API; the zod parse runs here, after the stop reason is checked, so a
    // refusal or a cut-off answer is reported as such instead of as unparseable JSON.
    const { parse, ...format } = betaZodOutputFormat(req.schema);
    // Streaming: transcripts are long and the model thinks before answering.
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens ?? 32_000,
      // Structured outputs on the beta surface (the header the SDK's own beta parse() sends), and
      // a request the model declines is re-run server-side on the fallback Anthropic recommends.
      betas: ['structured-outputs-2025-12-15', 'server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: req.effort, format },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });
    const message = await stream.finalMessage();

    const raw = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    };
    const usage: LlmUsage = { role: req.role, model: message.model, ...raw, costUsd: estimateCost(message.model, raw) };

    if (message.stop_reason === 'refusal') {
      throw new LlmError(`${req.role}: the model declined (${message.stop_details?.category ?? 'no category'})`, 'refusal', usage);
    }
    if (message.stop_reason === 'max_tokens') throw new LlmError(`${req.role}: output hit max_tokens`, 'truncated', usage);
    const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    try {
      return { data: parse(text), usage };
    } catch (err) {
      throw new LlmError(`${req.role}: ${(err as Error).message}`.slice(0, 500), 'invalid', usage);
    }
  }
}
