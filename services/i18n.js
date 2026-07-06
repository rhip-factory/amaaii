// Thin CJS shim. The real implementation now lives in
// packages/core/src/i18n.ts (P1-B: pure domain logic extraction — see
// CLAUDE.md). Kept as a same-named/same-shaped module so every existing
// consumer keeps working unchanged.
//
// `dangerCopy` is new here (it wasn't exported before this migration) —
// utils/messageHandler.js and services/journalManager.js each used to
// define an identical local `dangerCopy(level, lang)` helper; both now
// import the single shared implementation from core via this shim.
require('tsx/cjs');
const core = require('../packages/core/src/index.ts');

module.exports = {
  t: core.t,
  label: core.label,
  pickLang: core.pickLang,
  dangerCopy: core.dangerCopy,
};
