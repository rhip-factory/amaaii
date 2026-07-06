// Barrel for @amaaii/adapters — concrete I/O implementations of the
// @amaaii/core repository interfaces, plus other outbound integrations
// (Twilio). Populated during the gradual JS -> TS migration (see
// CLAUDE.md's phase-1 plan). OpenAI/LLM code is NOT here yet — that's
// the next package (services/amaaii.js, services/llmExtract.js stay
// untouched for now).

export * from './sqlite';
export * from './twilio';
