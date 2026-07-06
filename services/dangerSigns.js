// Thin CJS shim. The real implementation now lives in
// packages/core/src/dangerSigns.ts (P1-B: pure domain logic extraction —
// see CLAUDE.md). Kept as a same-named/same-shaped module so every
// existing consumer (utils/messageHandler.js, services/journalManager.js,
// tests, scripts/smoke) keeps working unchanged.
//
// `tsx/cjs` registers Node module hooks that let a plain CommonJS
// `require()` load TypeScript sources — including their own internal
// relative imports across packages/core/src/*.ts — under vitest, tsx,
// and plain `node` alike. Safe/idempotent to call from multiple files;
// under `tsx server.js` it's a harmless no-op (tsx's hooks are already
// registered process-wide).
require('tsx/cjs');
const core = require('../packages/core/src/index.ts');

module.exports = {
  detectDangerSigns: core.detectDangerSigns,
  assessMood: core.assessMood,
  extractSymptoms: core.extractSymptoms,
  DANGER_SIGNS: core.DANGER_SIGNS,
};
