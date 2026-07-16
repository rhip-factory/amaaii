// Barrel for @amaaii/adapters — concrete I/O implementations of the
// @amaaii/core repository interfaces, plus other outbound integrations
// (Twilio, OpenAI). Populated during the gradual JS -> TS migration (see
// CLAUDE.md's phase-1 plan). `./llm` is the single OpenAI chokepoint
// (P1-D) — services/amaaii.js and services/llmExtract.js call `chat()`
// from here instead of constructing their own OpenAI client.

export * from './sqlite';
export * from './twilio';
export * from './llm';
