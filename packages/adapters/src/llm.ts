// Single OpenAI chokepoint (P1-D: LLM redaction layer — see CLAUDE.md).
//
// No other file in this codebase is allowed to `require('openai')` /
// `import ... from 'openai'` directly. services/amaaii.js and
// services/llmExtract.js both call chat() below instead of constructing
// their own OpenAI client. This is what makes the redaction guarantee
// actually enforceable: there is exactly one place outbound conversation
// content can leave the process, and that place always redacts.
//
// TRUST BOUNDARY: chat() redacts every 'user' and 'assistant' message
// via @amaaii/core's redactForLLM() before it reaches the SDK. 'system'
// messages are passed through UNTOUCHED — they are built by our own
// prompt-construction code (services/amaaii.js's BASE/ONBOARDING/
// MENTAL_HEALTH prompts + USER_CONTEXT block, services/llmExtract.js's
// field-extraction instructions), which is the one place explicitly
// allowed to embed the user's FIRST NAME for personalization. See
// packages/core/src/redaction.ts's "FIRST-NAME POLICY" comment for the
// full rationale — that file is the actual policy; this comment just
// restates the half of it this module is responsible for enforcing.
//
// Lazy client init, same rationale as this package's twilio.ts
// getClient(): the OpenAI SDK throws AT CONSTRUCTION TIME if no API key
// is available (env or explicit) — verified empirically; constructing
// eagerly at module load (which is what services/amaaii.js used to do)
// means the whole require chain — and therefore the server — cannot
// boot without OPENAI_API_KEY set. Constructing lazily, on the first
// real chat() call, defers that failure to the point an actual
// completion is attempted, where callers already have a try/catch
// (services/amaaii.js) or an existing `if (!isLlmConfigured()) return null`
// short-circuit (services/llmExtract.js).
//
// PROVIDER: OpenAI directly, or OpenRouter (an OpenAI-compatible gateway
// that routes to OpenAI and other model vendors). OPENROUTER_API_KEY set
// wins; otherwise OPENAI_API_KEY. The same `openai` SDK speaks to both —
// only the baseURL and the model id format (`openai/gpt-3.5-turbo` vs
// `gpt-3.5-turbo`) differ, and resolveModel() below handles the latter so
// callers keep passing plain OpenAI model names.

import OpenAI from 'openai';
import { redactForLLM } from '@amaaii/core';
// P4-B: metrics increments live at THIS single chokepoint (not at
// amaaii.ts's or llmExtract.ts's call sites) per CLAUDE.md's
// single-LLM-chokepoint rule — same "one funnel, instrumented once"
// reasoning as apps/server/src/audit.ts#auditDangerEscalation.
// packages/adapters already depends on a file inside apps/server for
// its logger (see connection.ts's own comment on this same
// cross-boundary import) — this is the same pre-existing, documented
// shortcut, not a new pattern introduced here.
import { incrementLlmCall, incrementLlmFailure } from '../../../apps/server/src/metrics';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type ChatResponseFormat =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['response_format'];

export interface ChatOptions {
  /** Defaults to 'gpt-3.5-turbo' — no model change in this package (see
   *  CLAUDE.md's P1-D constraints). Callers pass it explicitly today
   *  anyway; this default just means an omitted model doesn't silently
   *  hit a different one. */
  model?: string;
  max_tokens?: number;
  temperature?: number;
  response_format?: ChatResponseFormat;
  /** 'extract' = a structured-field fallback (llmExtract.ts), which may run
   *  on a different, faster model via LLM_EXTRACT_MODEL. 'clarify' = the
   *  check-in's "what did you mean?" question, worth a stronger model
   *  (LLM_CLARIFY_MODEL). Default 'reply'. */
  purpose?: 'reply' | 'extract' | 'clarify';
  /** Stored user record — used ONLY to strip the user's FULL name out
   *  of user/assistant message content. Never used to add anything to
   *  the outbound request. Omit if the caller has no user context
   *  (e.g. services/llmExtract.js's field extractors, which only ever
   *  see raw free text with no associated user row). */
  user?: { name?: string | null } | null;
}

const DEFAULT_MODEL = 'gpt-3.5-turbo';
/** "What did you mean?" runs rarely and she is waiting on it: worth Sonnet. */
const DEFAULT_CLARIFY_MODEL = 'anthropic/claude-sonnet-5.5';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

let cachedClient: OpenAI | null = null;

function usingOpenRouter(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

/** True when either provider has a key — callers short-circuit on false. */
export function isLlmConfigured(): boolean {
  return !!(process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY);
}

/**
 * LLM_MODEL, when set, overrides every caller's model (one switch for the
 * whole app, e.g. `openai/gpt-4o-mini`). LLM_EXTRACT_MODEL, when set, wins
 * over it for extraction calls — extraction runs under a tight timeout
 * while the mother waits, so it can stay on a fast model even if replies
 * move to a slower one. Otherwise the caller's plain OpenAI name is used,
 * prefixed with `openai/` on OpenRouter so it hits the same model there.
 * The check-in's clarify question has its own LLM_CLARIFY_MODEL (Sonnet by
 * default on OpenRouter): it runs only on unclear answers.
 */
export function resolveModel(requested: string, purpose: ChatOptions['purpose'] = 'reply'): string {
  if (purpose === 'clarify') {
    if (process.env.LLM_CLARIFY_MODEL) return process.env.LLM_CLARIFY_MODEL;
    if (usingOpenRouter()) return DEFAULT_CLARIFY_MODEL;
    // Plain OpenAI: no Claude there; use the extraction model.
    return resolveModel(requested, 'extract');
  }
  if (purpose === 'extract' && process.env.LLM_EXTRACT_MODEL) return process.env.LLM_EXTRACT_MODEL;
  if (process.env.LLM_MODEL) return process.env.LLM_MODEL;
  if (usingOpenRouter() && !requested.includes('/')) return `openai/${requested}`;
  return requested;
}

export function getOpenAIClient(): OpenAI {
  if (cachedClient) return cachedClient;
  cachedClient = usingOpenRouter()
    ? new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: OPENROUTER_BASE_URL,
        // Optional attribution headers OpenRouter shows on its dashboard.
        defaultHeaders: {
          'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'https://amaaii.com',
          'X-Title': 'Amaaii',
        },
      })
    : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return cachedClient;
}

// Test seam mirroring packages/adapters/src/whatsapp.ts's
// __setSendImpl/__resetSendImpl: lets tests inject a mock client (e.g. a
// stub with a spied `chat.completions.create`) without a network call or
// a real OPENAI_API_KEY, and lets them reset the singleton afterwards.
export function __setClient(client: OpenAI): void {
  cachedClient = client;
}

export function __resetClient(): void {
  cachedClient = null;
}

/**
 * Redacts a single message per the trust boundary described above:
 * 'system' passes through untouched; 'user'/'assistant' go through
 * redactForLLM() (full pattern redaction + the user's full stored name,
 * if a user record was supplied).
 */
function redactMessage(message: ChatMessage, user?: ChatOptions['user']): ChatMessage {
  if (message.role === 'system') return message;
  return { role: message.role, content: redactForLLM(message.content, user) };
}

/**
 * The one function that actually talks to OpenAI. `messages` mirrors the
 * plain `{ role, content }[]` shape services/amaaii.js and
 * services/llmExtract.js already built by hand — this function is a
 * drop-in replacement for their old `openai.chat.completions.create(...)`
 * call, not a new abstraction they need to learn. Returns the raw SDK
 * ChatCompletion so callers keep their existing
 * `completion.choices[0].message.content` parsing unchanged.
 */
export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const { model = DEFAULT_MODEL, max_tokens, temperature, response_format, purpose, user } = opts;

  const redactedMessages = messages.map((m) => redactMessage(m, user));

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: resolveModel(model, purpose),
    messages: redactedMessages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    ...(max_tokens != null ? { max_tokens } : {}),
    ...(temperature != null ? { temperature } : {}),
    ...(response_format ? { response_format } : {}),
  };

  // On OpenRouter, only route to providers that neither store nor train on
  // prompts — these are pregnancy health conversations. Enforced per
  // request so it can't silently depend on account settings. (`zdr: true`
  // is stricter but currently matches no OpenAI endpoint.)
  //
  // Reasoning is pinned to 'minimal' for the same keep-it-explicit reason.
  // Claude Haiku/Sonnet 5.5 think by default, and the thinking counts
  // against max_tokens: at our 80–320 token budgets it ate whole replies
  // (an empty completion, or one cut off mid-sentence) and blew the
  // extraction timeout. 'minimal' is the lowest level every model
  // accepts — 'none' is a 400 on Sonnet 5.5 — and non-reasoning models
  // like gpt-3.5-turbo ignore the field.
  const body = usingOpenRouter()
    ? ({ ...params, provider: { data_collection: 'deny' }, reasoning: { effort: 'minimal' } } as typeof params)
    : params;

  incrementLlmCall();
  try {
    return await getOpenAIClient().chat.completions.create(body);
  } catch (err) {
    incrementLlmFailure();
    throw err;
  }
}
