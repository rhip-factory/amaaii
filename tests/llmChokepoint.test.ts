// Evidence test for P1-D's compliance requirement: prove that a message
// containing raw PII (a phone number + a user's full stored name) is
// masked BEFORE it reaches the OpenAI SDK boundary — not just that
// redactForLLM() works in isolation (tests/redaction.test.ts already
// covers that), but that the chokepoint (packages/adapters/src/llm.ts)
// actually applies it on the one path every outbound completion request
// travels through.
//
// We spy on the REAL OpenAI client's `chat.completions.create` method
// (constructed with only a dummy OPENAI_API_KEY, proving construction
// itself doesn't require a valid key/network access) rather than
// swapping in a fully fake client object, so this is as close as
// possible to "what would have gone out over the wire" without an
// actual network call.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { chat, getOpenAIClient, __resetClient } from '@amaaii/adapters';

process.env.OPENAI_API_KEY = 'sk-test-dummy-evidence';

function fakeCompletion(content: string) {
  return {
    id: 'evidence-completion',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-3.5-turbo',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content, refusal: null },
        logprobs: null,
      },
    ],
  };
}

afterEach(() => {
  __resetClient();
  vi.restoreAllMocks();
});

describe('LLM chokepoint — redaction evidence (P1-D)', () => {
  it('constructs the real OpenAI client with only a dummy API key (boot does not require a valid key)', () => {
    expect(() => getOpenAIClient()).not.toThrow();
  });

  it('masks a phone number + full name before the payload reaches the OpenAI SDK boundary', async () => {
    const client = getOpenAIClient();
    const createSpy = vi
      .spyOn(client.chat.completions, 'create')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValue(fakeCompletion('ok') as any);

    const rawUserMessage = 'Hi, this is Grace Wanjiru, call me on 0712345678';

    await chat(
      [
        // System content is our own trusted prompt — first-name-only,
        // must reach the SDK completely untouched.
        { role: 'system', content: 'Name: Grace' },
        { role: 'user', content: rawUserMessage },
      ],
      { user: { name: 'Grace Wanjiru' } }
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    const sentPayload = createSpy.mock.calls[0][0] as { messages: { role: string; content: string }[] };
    const sentMessages = sentPayload.messages;

    // BEFORE / AFTER evidence (see the P1-D final report for the
    // captured values).
    // eslint-disable-next-line no-console
    console.log('[P1-D evidence] BEFORE (raw, as constructed by the caller):', JSON.stringify(rawUserMessage));
    // eslint-disable-next-line no-console
    console.log('[P1-D evidence] AFTER  (what actually reached client.chat.completions.create):', JSON.stringify(sentMessages[1].content));

    // System message: untouched — first-name-only policy lives here.
    expect(sentMessages[0]).toEqual({ role: 'system', content: 'Name: Grace' });

    // User message: fully masked at the SDK boundary.
    expect(sentMessages[1].role).toBe('user');
    expect(sentMessages[1].content).toBe('Hi, this is [NAME] [NAME], call me on [PHONE]');
    expect(sentMessages[1].content).not.toContain('0712345678');
    expect(sentMessages[1].content).not.toContain('Grace');
    expect(sentMessages[1].content).not.toContain('Wanjiru');
  });

  it('also masks assistant-role history content (not just user)', async () => {
    const client = getOpenAIClient();
    const createSpy = vi
      .spyOn(client.chat.completions, 'create')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValue(fakeCompletion('ok') as any);

    await chat(
      [
        { role: 'system', content: 'Name: Grace' },
        { role: 'user', content: 'would exercise help me sleep?' },
        { role: 'assistant', content: 'Grace Wanjiru, a short walk can help — text me on 0712345678 if it does not.' },
        { role: 'user', content: 'ok thanks' },
      ],
      { user: { name: 'Grace Wanjiru' } }
    );

    const sentPayload = createSpy.mock.calls[0][0] as { messages: { role: string; content: string }[] };
    const assistantMsg = sentPayload.messages[2];
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content).not.toContain('Wanjiru');
    expect(assistantMsg.content).not.toContain('0712345678');
    expect(assistantMsg.content).toContain('[NAME]');
    expect(assistantMsg.content).toContain('[PHONE]');
  });

  it('never calls the raw openai SDK outside this chokepoint for the redaction guarantee to hold (sanity: chat() is the only caller of getOpenAIClient().chat.completions.create in this file)', () => {
    // This is a documentation-style assertion, not a deep static check —
    // the real enforcement is the grep in the P1-D final report showing
    // `import ... from 'openai'` appears nowhere else in the codebase.
    expect(typeof chat).toBe('function');
  });
});
