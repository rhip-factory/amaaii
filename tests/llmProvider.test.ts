// Provider selection at the LLM chokepoint (packages/adapters/src/llm.ts):
// OpenRouter when OPENROUTER_API_KEY is set, OpenAI otherwise, with
// resolveModel() keeping callers' plain OpenAI model names working on both.
// Same spy-on-the-real-client approach as tests/llmChokepoint.test.ts — no
// network calls.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { chat, getOpenAIClient, isLlmConfigured, resolveModel, __resetClient } from '@amaaii/adapters';

function fakeCompletion() {
  return {
    id: 'provider-completion',
    object: 'chat.completion',
    created: 0,
    model: 'x',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok', refusal: null }, logprobs: null }],
  };
}

afterEach(() => {
  __resetClient();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('LLM provider selection', () => {
  it('uses OpenAI directly when only OPENAI_API_KEY is set', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai');
    vi.stubEnv('LLM_MODEL', '');
    expect(getOpenAIClient().baseURL).toBe('https://api.openai.com/v1');
    expect(resolveModel('gpt-3.5-turbo')).toBe('gpt-3.5-turbo');
  });

  it('uses OpenRouter when OPENROUTER_API_KEY is set, mapping plain model names to openai/*', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai');
    vi.stubEnv('LLM_MODEL', '');
    expect(getOpenAIClient().baseURL).toBe('https://openrouter.ai/api/v1');
    expect(getOpenAIClient().apiKey).toBe('sk-or-test');
    expect(resolveModel('gpt-3.5-turbo')).toBe('openai/gpt-3.5-turbo');
    expect(resolveModel('anthropic/claude-haiku-4.5')).toBe('anthropic/claude-haiku-4.5');
  });

  it('sends no OpenRouter-only fields to OpenAI', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai');
    const create = vi
      .spyOn(getOpenAIClient().chat.completions, 'create')
      .mockResolvedValue(fakeCompletion() as never);
    await chat([{ role: 'user', content: 'hello' }], { model: 'gpt-3.5-turbo' });
    expect(create.mock.calls[0][0]).not.toHaveProperty('provider');
  });

  it('LLM_MODEL overrides every caller', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.stubEnv('LLM_MODEL', 'openai/gpt-4o-mini');
    expect(resolveModel('gpt-3.5-turbo')).toBe('openai/gpt-4o-mini');
  });

  it('chat() sends the resolved model', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.stubEnv('LLM_MODEL', '');
    const create = vi
      .spyOn(getOpenAIClient().chat.completions, 'create')
      .mockResolvedValue(fakeCompletion() as never);
    await chat([{ role: 'user', content: 'hello' }], { model: 'gpt-3.5-turbo' });
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'openai/gpt-3.5-turbo',
      provider: { data_collection: 'deny' },
    });
  });

  it('isLlmConfigured is true with either key and false with neither', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(isLlmConfigured()).toBe(false);
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    expect(isLlmConfigured()).toBe(true);
  });
});
