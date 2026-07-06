// P1-E: ported 1:1 from services/trend.js (final step of the TS
// migration — see CLAUDE.md). Recent-history rollup. Used to give the
// AI memory of the last week so it can talk like a companion who
// remembers, not a stateless bot. Also feeds the Home dashboard
// "Insights" card and the journal greeting's "did the X you mentioned
// yesterday stop?" follow-up.
//
// SAFETY: This is for warmth and context only. Triage stays a function
// of the *current message*, never aggregated history (spec §6.2).
//
// The pure computation half lives in packages/core/src/trend.ts
// (computeTrend); this file is the thin orchestration layer that fetches
// rows and delegates the math to core.

import { computeTrend, trendForPrompt, type TrendSummary } from '@amaaii/core';
import { getJournalHistory } from './database';

// `windowDays` is how far back we summarise.
// Returns null when the user has no journal history at all (so callers
// can fall back to first-time messaging).
export async function getRecentTrend(userPhone: string, windowDays = 7): Promise<TrendSummary | null> {
  const journals = await getJournalHistory(userPhone, windowDays);
  return computeTrend(journals, windowDays);
}

export { trendForPrompt };
