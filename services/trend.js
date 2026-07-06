// Recent-history rollup. Used to give the AI memory of the last week
// so it can talk like a companion who remembers, not a stateless bot.
// Also feeds the Home dashboard "Insights" card and the journal
// greeting's "did the X you mentioned yesterday stop?" follow-up.
//
// SAFETY: This is for warmth and context only. Triage stays a function
// of the *current message*, never aggregated history (spec §6.2).
//
// P1-B: split into a DB-fetching half (this file) and a pure
// computation half (packages/core/src/trend.ts#computeTrend). This
// file is no longer a shim of a single 1:1 port — it's the thin
// orchestration layer that fetches rows and delegates the math to core.
require('tsx/cjs');
const db = require('./database');
const core = require('../packages/core/src/index.ts');

// `windowDays` is how far back we summarise.
// Returns null when the user has no journal history at all (so callers
// can fall back to first-time messaging).
async function getRecentTrend(userPhone, windowDays = 7) {
  const journals = await db.getJournalHistory(userPhone, windowDays);
  return core.computeTrend(journals, windowDays);
}

module.exports = { getRecentTrend, trendForPrompt: core.trendForPrompt };
