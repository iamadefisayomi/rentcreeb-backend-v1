import { env } from '../config/env';
import { logger } from './logger';

/**
 * Minimal client for any OpenAI-compatible chat API (default: NVIDIA build.nvidia.com).
 * Switch provider with AI_BASE_URL / AI_API_KEY / AI_MODEL on the server; no code changes.
 * Every call is rate limited (AI_MAX_RPM) and never throws: callers get null and carry on without AI.
 */
export type AiPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type AiMessage = { role: 'system' | 'user' | 'assistant'; content: string | AiPart[] };

const apiKey = () => env.AI_API_KEY || env.NVIDIA_API_KEY || '';
export const aiEnabled = () => !!apiKey();
export const aiModel = () => env.AI_MODEL;

// Space calls out evenly so a burst never trips the provider's per-minute limit. A 429 pushes every later call back.
let nextSlot = 0;
export const aiPausedUntil = () => nextSlot;
async function slot() {
  const gap = 60_000 / env.AI_MAX_RPM;
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** Pull the first JSON object out of a reply (models sometimes wrap it in ``` fences or add a sentence). */
export function parseJsonObject<T = any>(text: string | null | undefined): T | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)) as T; } catch { return null; }
}

export async function aiChat(messages: AiMessage[], opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {}): Promise<string | null> {
  if (!aiEnabled()) return null;
  await slot();
  const started = Date.now();
  try {
    const res = await fetch(`${env.AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model: env.AI_MODEL, messages, max_tokens: opts.maxTokens ?? 900, temperature: opts.temperature ?? 0.1,
        // Reasoning models (Nemotron, etc.) answer faster and within the token budget with thinking off; others ignore this.
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.status === 429) {
      // Throttled: honour Retry-After (seconds) or back off 30 s, for every caller, not just this one.
      const wait = Math.min(120, Math.max(5, Number(res.headers.get('retry-after')) || 30)) * 1000;
      nextSlot = Math.max(nextSlot, Date.now() + wait);
      logger.warn({ waitSec: wait / 1000 }, 'AI provider rate limit: backing off');
      return null;
    }
    if (!res.ok) { logger.warn({ status: res.status, detail: json?.detail ?? json?.error?.message ?? json?.message, model: env.AI_MODEL }, 'AI request failed'); return null; }
    const text = json?.choices?.[0]?.message?.content ?? null;
    logger.debug({ ms: Date.now() - started, model: env.AI_MODEL, tokens: json?.usage?.total_tokens }, 'AI reply');
    return typeof text === 'string' ? text : null;
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message ?? err), model: env.AI_MODEL }, 'AI request error');
    return null;
  }
}

export async function aiJson<T = any>(messages: AiMessage[], opts?: Parameters<typeof aiChat>[1]): Promise<T | null> {
  return parseJsonObject<T>(await aiChat(messages, opts));
}

/** For the admin System page: is the key accepted and the model reachable? (Lists models; costs no generation.) */
export async function aiHealth(): Promise<{ ok: boolean; model: string; detail?: string }> {
  if (!aiEnabled()) return { ok: false, model: env.AI_MODEL, detail: 'No AI_API_KEY / NVIDIA_API_KEY set: AI features are off' };
  try {
    const res = await fetch(`${env.AI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey()}` }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return { ok: false, model: env.AI_MODEL, detail: `Provider refused the key (${res.status})` };
    const json: any = await res.json().catch(() => ({}));
    const has = (json?.data ?? []).some((m: any) => m.id === env.AI_MODEL);
    return has ? { ok: true, model: env.AI_MODEL } : { ok: false, model: env.AI_MODEL, detail: 'Model not offered by this provider: set AI_MODEL' };
  } catch (err) { return { ok: false, model: env.AI_MODEL, detail: String((err as Error)?.message ?? err) }; }
}

// ───────── Tool calling (OpenAI "function calling" format), used by the RentCreeb Assistant ─────────
export type AiTool = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type AiToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type AiChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: AiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type AiToolReply = { content: string | null; toolCalls: AiToolCall[]; finishReason: string | null; usage: { input: number; output: number } };

/**
 * One chat completion that may ask for tool calls. Returns null on any failure (rate limit, network, bad key) so the
 * caller can apologise instead of crashing. Shares the per-minute limiter with every other AI call.
 */
export async function aiToolChat(messages: AiChatMessage[], tools: AiTool[], opts: { model?: string; maxTokens?: number; temperature?: number; timeoutMs?: number } = {}): Promise<AiToolReply | null> {
  if (!aiEnabled()) return null;
  await slot();
  const model = opts.model ?? env.AI_MODEL;
  try {
    const res = await fetch(`${env.AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model, messages, tools, tool_choice: 'auto', max_tokens: opts.maxTokens ?? 1500, temperature: opts.temperature ?? 0.3,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.status === 429) {
      const wait = Math.min(120, Math.max(5, Number(res.headers.get('retry-after')) || 30)) * 1000;
      nextSlot = Math.max(nextSlot, Date.now() + wait);
      logger.warn({ waitSec: wait / 1000 }, 'AI provider rate limit: backing off');
      return null;
    }
    if (!res.ok) { logger.warn({ status: res.status, detail: json?.detail ?? json?.error?.message ?? json?.message, model }, 'AI tool request failed'); return null; }
    const choice = json?.choices?.[0];
    const msg = choice?.message ?? {};
    return {
      content: typeof msg.content === 'string' ? msg.content : null,
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls.filter((c: any) => c?.function?.name) : [],
      finishReason: choice?.finish_reason ?? null,
      usage: { input: json?.usage?.prompt_tokens ?? 0, output: json?.usage?.completion_tokens ?? 0 },
    };
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message ?? err), model }, 'AI tool request error');
    return null;
  }
}
