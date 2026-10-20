// Hardening found by running Claude Haiku/Sonnet 5.5 through OpenRouter:
// thinking models can spend max_tokens on reasoning (empty or truncated
// replies), and json_object isn't enforced for them (prose or a fenced
// block around the JSON). Spies on the real client like
// tests/llmProvider.test.ts — no network calls.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { chat, getOpenAIClient, resolveModel, __resetClient } from '@amaaii/adapters';
import { extractMood, extractWeekOrLMP, parseJsonReply } from '../apps/server/src/llmExtract';
import { getAmaaiiResponse } from '../apps/server/src/amaaii';

function fakeCompletion(content: string | null, finish_reason = 'stop') {
  return {
    id: 'robustness-completion',
    object: 'chat.completion',
    created: 0,
    model: 'x',
    choices: [{ index: 0, finish_reason, message: { role: 'assistant', content, refusal: null }, logprobs: null }],
  };
}

function stubCreate(content: string | null, finish_reason?: string) {
  return vi
    .spyOn(getOpenAIClient().chat.completions, 'create')
    .mockResolvedValue(fakeCompletion(content, finish_reason) as never);
}

afterEach(() => {
  __resetClient();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('parseJsonReply', () => {
  it('parses a plain JSON reply', () => {
    expect(parseJsonReply('{"weeks": 22}')).toEqual({ weeks: 22 });
  });

  it('parses a ```json fenced block after prose (Sonnet 5.5 via OpenRouter)', () => {
    const raw = 'Five months is roughly 22 weeks.\n\n```json\n{"weeks": 22}\n```';
    expect(parseJsonReply(raw)).toEqual({ weeks: 22 });
  });

  it('parses a JSON object followed by trailing text', () => {
    expect(parseJsonReply('{"hours": 4} (she said "maybe 4")')).toEqual({ hours: 4 });
  });

  it('skips braces in prose that are not JSON, and braces inside strings', () => {
    expect(parseJsonReply('Shape {weeks} gives: {"note": "a } b", "weeks": 18}')).toEqual({ note: 'a } b', weeks: 18 });
  });

  it('throws when there is no JSON object', () => {
    expect(() => parseJsonReply('I could not tell.')).toThrow();
  });
});

describe('extraction model + tolerant parsing', () => {
  it('LLM_EXTRACT_MODEL wins for extraction only', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.stubEnv('LLM_MODEL', 'anthropic/claude-sonnet-5.5');
    vi.stubEnv('LLM_EXTRACT_MODEL', 'anthropic/claude-haiku-5.5');
    expect(resolveModel('gpt-3.5-turbo')).toBe('anthropic/claude-sonnet-5.5');
    expect(resolveModel('gpt-3.5-turbo', 'extract')).toBe('anthropic/claude-haiku-5.5');
  });

  it('extraction falls back to LLM_MODEL when LLM_EXTRACT_MODEL is unset', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.stubEnv('LLM_MODEL', 'anthropic/claude-haiku-5.5');
    vi.stubEnv('LLM_EXTRACT_MODEL', '');
    expect(resolveModel('gpt-3.5-turbo', 'extract')).toBe('anthropic/claude-haiku-5.5');
  });

  it('an extractor sends the extraction model and reads a fenced reply', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.stubEnv('LLM_MODEL', 'anthropic/claude-sonnet-5.5');
    vi.stubEnv('LLM_EXTRACT_MODEL', 'anthropic/claude-haiku-5.5');
    const create = stubCreate('Roughly 22 weeks.\n```json\n{"weeks": 22, "lmp": null}\n```');
    expect(await extractWeekOrLMP('nina miezi mitano')).toEqual({ weeks: 22 });
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'anthropic/claude-haiku-5.5' });
  });
});

describe('reasoning effort', () => {
  it('pins reasoning to minimal on OpenRouter', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const create = stubCreate('ok');
    await chat([{ role: 'user', content: 'hello' }]);
    expect(create.mock.calls[0][0]).toMatchObject({ reasoning: { effort: 'minimal' } });
  });

  it('sends no reasoning field to OpenAI directly', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai');
    const create = stubCreate('ok');
    await chat([{ role: 'user', content: 'hello' }]);
    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning');
  });
});

describe('empty AI replies', () => {
  it.each([
    ['null content', null],
    ['whitespace-only content', '  \n'],
  ])('falls back to the canned apology on %s instead of sending it', async (_label, content) => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    stubCreate(content, 'length');
    const reply = await getAmaaiiResponse('Nimekuwa na kiungulia sana usiku', { userName: 'Wanjiru' });
    expect(reply).not.toBe('null');
    expect(reply).toMatch(/having trouble processing your message/);
  });

  it('gives replies room for Claude-length Swahili answers (cap ≥ 800)', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const create = stubCreate('Pole sana, Wanjiru.');
    await getAmaaiiResponse('hi', { userName: 'Wanjiru' });
    expect((create.mock.calls[0][0] as { max_tokens: number }).max_tokens).toBeGreaterThanOrEqual(800);
  });

  it('returns a real reply trimmed', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    stubCreate('  Pole sana, Wanjiru. 💚 \n');
    expect(await getAmaaiiResponse('hi', { userName: 'Wanjiru' })).toBe('Pole sana, Wanjiru. 💚');
  });
});

describe('extraction calls', () => {
  it('leave room for Claude reasoning tokens (80 came back empty; cap ≥ 300)', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const create = stubCreate('{"mood": 6}');
    await extractMood('meh');
    expect((create.mock.calls[0][0] as { max_tokens: number }).max_tokens).toBeGreaterThanOrEqual(300);
  });
});
