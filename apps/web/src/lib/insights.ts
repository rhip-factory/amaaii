// Pure helpers for the Insights tab + the Home trends card (P2-E).
// No fetching, no DOM — unit-tested from the root vitest suite
// (tests/moodDirection.test.ts), same pattern as offlineCache.ts.

import type { SeriesPoint } from "./types";

export type MoodDirection = "improving" | "steady" | "declining";

// Derive an honest trend direction from the per-day averaged mood series
// (which core's computeDailySeries produced server-side): compare the
// mean of the more recent half of the points against the earlier half.
// A difference under `threshold` (default 0.5 on the 1–10 scale) is
// reported as "steady" — day-to-day mood is noisy, and telling a mother
// her mood is "declining" over a 0.2-point wobble would be neither
// honest nor kind. Fewer than 2 points -> null (no claim at all).
//
// NOTE: core's computeTrend has no direction field, so this derivation
// lives here, one step downstream of core's series math. Points must be
// date-ascending (the API guarantees it).
export function computeMoodDirection(points: SeriesPoint[], threshold = 0.5): MoodDirection | null {
  if (points.length < 2) return null;
  const half = Math.floor(points.length / 2);
  const earlier = points.slice(0, half);
  // For odd counts the middle point counts toward "recent".
  const recent = points.slice(half);
  const mean = (xs: SeriesPoint[]) => xs.reduce((sum, p) => sum + p.value, 0) / xs.length;
  const delta = mean(recent) - mean(earlier);
  if (delta >= threshold) return "improving";
  if (delta <= -threshold) return "declining";
  return "steady";
}

// Keep only the points from the last `days` days (inclusive of today).
// Dates are the server's UTC YYYY-MM-DD strings, so plain string
// comparison against a UTC cutoff is exact. `now` is injectable for tests.
export function sliceLastDays(points: SeriesPoint[], days: number, now: Date = new Date()): SeriesPoint[] {
  const cutoff = new Date(now.getTime() - (days - 1) * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return points.filter((p) => p.date >= cutoff);
}

// One wording per direction — no fake positivity: a decline is named
// gently and paired (in the card body) with a check-in suggestion.
export function moodDirectionHeadline(direction: MoodDirection): string {
  switch (direction) {
    case "improving":
      return "Mood improving this week";
    case "declining":
      return "Mood has dipped this week";
    case "steady":
    default:
      return "Mood steady this week";
  }
}

export function moodDirectionBody(direction: MoodDirection): string {
  switch (direction) {
    case "improving":
      return "Your recent check-ins have been trending up. Keep doing what's working.";
    case "declining":
      return "Your recent check-ins have been a little lower. A quick check-in today helps me understand what's changed.";
    case "steady":
    default:
      return "Your check-ins have been holding steady.";
  }
}

// Stat-tile word for the Insights window's direction.
export function moodDirectionWord(direction: MoodDirection | null): string {
  switch (direction) {
    case "improving":
      return "Improving";
    case "declining":
      return "Dipping";
    case "steady":
      return "Steady";
    default:
      return "—";
  }
}
