// Thin CJS shim. The real implementation now lives in
// packages/adapters/src/twilio.ts (P1-C: repository pattern + adapters —
// see CLAUDE.md). Kept as a same-named/same-shaped module so every
// existing consumer (utils/messageHandler.js, tests) keeps working
// unchanged. The lazy Twilio client init (commit 19af4a2 — the server
// must boot without Twilio creds) is preserved inside the .ts source;
// this shim does not re-implement or cache anything of its own.
//
// `tsx/cjs` registers Node module hooks that let a plain CommonJS
// `require()` load TypeScript sources under vitest, tsx, and plain
// `node` alike. Safe/idempotent to call from multiple files.
require('tsx/cjs');
const adapters = require('../packages/adapters/src/index.ts');

module.exports = {
  sendWhatsAppMessage: adapters.sendWhatsAppMessage,
  getClient: adapters.getClient,
  __setSendImpl: adapters.__setSendImpl,
  __resetSendImpl: adapters.__resetSendImpl,
};
