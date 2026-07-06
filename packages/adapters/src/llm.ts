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
// (services/amaaii.js) or an existing `if (!OPENAI_API_KEY) return null`
// short-circuit (services/llmExtract.js).

import OpenAI from 'openai';
import { redactForLLM } from '@amaaii/core';

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
  /** Stored user record — used ONLY to strip the user's FULL name out
   *  of user/assistant message content. Never used to add anything to
   *  the outbound request. Omit if the caller has no user context
   *  (e.g. services/llmExtract.js's field extractors, which only ever
   *  see raw free text with no associated user row). */
  user?: { name?: string | null } | null;
}

const DEFAULT_MODEL = 'gpt-3.5-turbo';

let cachedClient: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (cachedClient) return cachedClient;
  cachedClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return cachedClient;
}

// Test seam mirroring packages/adapters/src/twilio.ts's
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
  const { model = DEFAULT_MODEL, max_tokens, temperature, response_format, user } = opts;

  const redactedMessages = messages.map((m) => redactMessage(m, user));

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages: redactedMessages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    ...(max_tokens != null ? { max_tokens } : {}),
    ...(temperature != null ? { temperature } : {}),
    ...(response_format ? { response_format } : {}),
  };

  return getOpenAIClient().chat.completions.create(params);
}
