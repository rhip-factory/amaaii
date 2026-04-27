// Recent-history rollup. Used to give the AI memory of the last week
// so it can talk like a companion who remembers, not a stateless bot.
// Also feeds the Home dashboard "Insights" card and the journal
// greeting's "did the X you mentioned yesterday stop?" follow-up.
//
// SAFETY: This is for warmth and context only. Triage stays a function
// of the *current message*, never aggregated history (spec §6.2).

const db = require('./database');

function avg(values) {
  const xs = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function parseSymptoms(raw) {
  if (!raw || raw === 'none') return [];
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) return [];
  try {
    const arr = JSON.parse(trimmed);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

// `windowDays` is how far back we summarise.
// Returns null when the user has no journal history at all (so callers
// can fall back to first-time messaging).
async function getRecentTrend(userPhone, windowDays = 7) {
  const journals = await db.getJournalHistory(userPhone, windowDays);
  if (!journals || journals.length === 0) return null;

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().split('T')[0];

  const completed = journals.filter((j) => j.completed);
  const distinctDays = new Set(journals.map((j) => j.date));

  // Symptom counts across the window.
  const symptomCount = {};
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
    lastMood: completed[0] ? completed[0].emotional_state : null,
    yesterdaySymptoms,
    yesterdayMood: yesterdaysJournal ? yesterdaysJournal.emotional_state : null,
    yesterdayFlagged: yesterdaysJournal ? !!yesterdaysJournal.red_flags_detected : false,
  };
}

function round1(n) {
  if (n == null) return null;
  return Math.round(n * 10) / 10;
}

// Render the trend as a compact line for the AI system prompt.
// Kept short — adds < 80 tokens. Returns '' if no trend data.
function trendForPrompt(trend) {
  if (!trend || trend.totalEntries === 0) return '';
  const parts = [];
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

module.exports = { getRecentTrend, trendForPrompt };
