// Recent-history rollup. Used to give the AI memory of the last week
// so it can talk like a companion who remembers, not a stateless bot.
// Also feeds the Home dashboard "Insights" card and the journal
// greeting's "did the X you mentioned yesterday stop?" follow-up.
//
// SAFETY: This is for warmth and context only. Triage stays a function
// of the *current message*, never aggregated history (spec §6.2).
//
// This module is the PURE half of the original services/trend.js:
// given journal rows already fetched from the DB, compute the trend
// summary. The DB fetch itself (db.getJournalHistory) stays in
// services/trend.js, which now delegates the computation here.

import type { DailySeriesPoint, JournalRow, SymptomFrequency, TrendSummary } from './types';

function avg(values: (number | null | undefined)[]): number | null {
  const xs = values.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function parseSymptoms(raw: unknown): string[] {
  if (!raw || raw === 'none') return [];
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) return [];
  try {
    const arr = JSON.parse(trimmed);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function round1(n: number | null): number | null {
  if (n == null) return null;
  return Math.round(n * 10) / 10;
}

// Pure computation half of getRecentTrend(). `journals` is whatever
// db.getJournalHistory(userPhone, windowDays) returned. Returns null
// when there's no journal history at all (so callers can fall back to
// first-time messaging).
export function computeTrend(journals: JournalRow[] | null | undefined, windowDays = 7): TrendSummary | null {
  if (!journals || journals.length === 0) return null;

  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().split('T')[0];

  const completed = journals.filter((j) => j.completed);
  const distinctDays = new Set(journals.map((j) => j.date));

  // Symptom counts across the window.
  const symptomCount: Record<string, number> = {};
  let redFlagDays = 0;
  for (const j of journals) {
    parseSymptoms(j.physical_symptoms).forEach((s) => {
      symptomCount[s] = (symptomCount[s] || 0) + 1;
    });
    if (j.red_flags_detected) redFlagDays += 1;
  }
  const recurring = Object.entries(symptomCount)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => ({ symptom: s.replace(/_/g, ' '), days: n }));

  // Yesterday's flagged stuff — used by the greeting follow-up.
  const yesterdaysJournal = journals.find((j) => j.date === yesterday) || null;
  const yesterdaySymptoms = yesterdaysJournal
    ? parseSymptoms(yesterdaysJournal.physical_symptoms).map((s) => s.replace(/_/g, ' '))
    : [];

  return {
    windowDays,
    totalEntries: journals.length,
    completedEntries: completed.length,
    distinctDaysJournaled: distinctDays.size,
    avgMood: round1(avg(completed.map((j) => j.emotional_state))),
    avgSleepHours: round1(avg(completed.map((j) => j.sleep_hours))),
    avgSleepQuality: round1(avg(completed.map((j) => j.sleep_quality))),
    avgWaterGlasses: round1(avg(completed.map((j) => j.water_intake))),
    redFlagDays,
    recurringSymptoms: recurring,
    lastMood: completed[0] ? (completed[0].emotional_state ?? null) : null,
    yesterdaySymptoms,
    yesterdayMood: yesterdaysJournal ? (yesterdaysJournal.emotional_state ?? null) : null,
    yesterdayFlagged: yesterdaysJournal ? !!yesterdaysJournal.red_flags_detected : false,
  };
}

// ---- Insights (P2-E) --------------------------------------------------------
// Pure aggregation half of GET /insights. Given the journal rows already
// fetched from the DB, build the per-day chart series the PWA Insights
// tab renders. Kept here (not in the route) so it's testable without a
// DB and reusable by any future consumer (e.g. a doctor-report chart).

// PER-DAY AGGREGATION CHOICE: multiple check-ins on the same day are
// AVERAGED per metric (mean of that day's non-null mood values; same
// for sleep). Rationale: a day with a rough-morning 3 and a better-
// evening 7 is honestly "a 5 kind of day" — picking latest-wins would
// erase the morning entirely, and summing is meaningless on a 1–10
// scale. Values are rounded to 1 decimal, matching computeTrend's avg
// rounding. Days with no value for a metric are simply absent from that
// series (the chart plots real observations, it never invents zeros).
export function computeDailySeries(
  journals: JournalRow[] | null | undefined,
  metric: (j: JournalRow) => number | null | undefined
): DailySeriesPoint[] {
  const byDate = new Map<string, number[]>();
  for (const j of journals ?? []) {
    const v = metric(j);
    if (typeof v !== 'number' || Number.isNaN(v)) continue;
    const arr = byDate.get(j.date);
    if (arr) arr.push(v);
    else byDate.set(j.date, [v]);
  }
  return Array.from(byDate.entries())
    .map(([date, values]) => ({ date, value: round1(avg(values)) as number }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Symptom frequency across the window, top `limit` by count. Counts are
// per ENTRY (union-counted: each check-in that mentions a symptom adds
// 1), matching computeTrend's recurringSymptoms counting. Ties broken
// alphabetically so the output is deterministic.
export function computeSymptomCounts(
  journals: JournalRow[] | null | undefined,
  limit = 6
): SymptomFrequency[] {
  const counts: Record<string, number> = {};
  for (const j of journals ?? []) {
    parseSymptoms(j.physical_symptoms).forEach((s) => {
      counts[s] = (counts[s] || 0) + 1;
    });
  }
  return Object.entries(counts)
    .map(([symptom, count]) => ({ symptom: symptom.replace(/_/g, ' '), count }))
    .sort((a, b) => b.count - a.count || (a.symptom < b.symptom ? -1 : 1))
    .slice(0, limit);
}

// Distinct dates (ascending) on which any check-in carried a red flag —
// rendered as the coral danger markers on the Insights mood line.
export function computeRedFlagDates(journals: JournalRow[] | null | undefined): string[] {
  const dates = new Set<string>();
  for (const j of journals ?? []) {
    if (j.red_flags_detected) dates.add(j.date);
  }
  return Array.from(dates).sort();
}

// Render the trend as a compact line for the AI system prompt.
// Kept short — adds < 80 tokens. Returns '' if no trend data.
export function trendForPrompt(trend: TrendSummary | null | undefined): string {
  if (!trend || trend.totalEntries === 0) return '';
  const parts: string[] = [];
  parts.push(`Journaled ${trend.distinctDaysJournaled}/${trend.windowDays} days.`);
  if (trend.avgMood != null) parts.push(`Avg mood ${trend.avgMood}/10.`);
  if (trend.avgSleepHours != null) parts.push(`Avg sleep ${trend.avgSleepHours}h.`);
  if (trend.avgWaterGlasses != null) parts.push(`Avg water ${trend.avgWaterGlasses} glasses.`);
  if (trend.recurringSymptoms.length > 0) {
    const list = trend.recurringSymptoms.slice(0, 3)
      .map((s) => `${s.symptom} (${s.days}d)`).join(', ');
    parts.push(`Recurring: ${list}.`);
  }
  if (trend.redFlagDays > 0) {
    parts.push(`Red flags noted on ${trend.redFlagDays} day(s).`);
  }
  if (trend.yesterdaySymptoms.length > 0) {
    parts.push(`Yesterday they mentioned: ${trend.yesterdaySymptoms.join(', ')}.`);
  }
  return parts.join(' ');
}
