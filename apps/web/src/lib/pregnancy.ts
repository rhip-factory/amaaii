// Gestational-week math + the "size comparison" lookup table that powers
// the home-screen week ribbon (the signature visual element — see the
// P2-A design brief). Comparisons use Kenyan produce vernacular so a
// mother in Nairobi or Kisumu recognises the reference immediately.

// Profile input allows up to week 42 (post-term is a real, if rare, case
// — matches the existing profile form's min/max). The ribbon itself is
// scaled to a standard 40-week term per the design brief, independent of
// that input ceiling.
// 0 is a real week: an LMP within the last 6 days dates to week 0.
export const WEEK_MIN = 0;
export const WEEK_MAX = 42;
export const RIBBON_WEEKS = 40;

/** Weeks below this show the ribbon but no produce comparison yet. */
const PRODUCE_MIN_WEEK = 4;
const PRODUCE_MAX_WEEK = 40;

export interface ProduceEntry {
  item: string;
  /** "about the size of a maize cob" */
  phrase: string;
}

// Anchor: week 24 ≈ "about the size of a maize cob" (per design brief).
// Sizes trend upward; items are chosen for everyday recognizability
// across Kenya rather than strict biological accuracy.
const PRODUCE_BY_WEEK: Record<number, string> = {
  4: "a sesame seed",
  5: "a coffee bean",
  6: "a green gram",
  7: "a groundnut",
  8: "a kidney bean",
  9: "a grape",
  10: "a garden pea pod",
  11: "a fig",
  12: "a passion fruit",
  13: "a lemon",
  14: "a small guava",
  15: "an apple",
  16: "an orange",
  17: "a green pepper",
  18: "an avocado",
  19: "a mango",
  20: "a banana",
  21: "a carrot",
  22: "a small paw paw",
  23: "a cassava tuber",
  24: "a maize cob",
  25: "a cucumber",
  26: "an eggplant",
  27: "a small cabbage",
  28: "a butternut squash",
  29: "a sweet potato",
  30: "a pineapple",
  31: "a coconut",
  32: "a stick of sugarcane",
  33: "a small pumpkin",
  34: "a head of cabbage",
  35: "a large pumpkin",
  36: "a jackfruit",
  37: "a small watermelon",
  38: "a large watermelon",
  39: "a giant pumpkin",
  40: "a bunch of matoke",
};

/** Clamp any week to the table's covered range, then look up its produce. */
export function produceForWeek(week: number): ProduceEntry | null {
  const clamped = Math.min(PRODUCE_MAX_WEEK, Math.max(PRODUCE_MIN_WEEK, Math.round(week)));
  const item = PRODUCE_BY_WEEK[clamped];
  if (!item) return null;
  return { item, phrase: `About the size of ${item}.` };
}

export interface WeekSource {
  pregnancy_week?: number | null;
  edd?: string | null;
}

/**
 * Resolve "today's" gestational week from a /me profile. Prefers the EDD
 * (expected delivery date) when present, since it advances automatically;
 * pregnancy_week alone is a snapshot from whenever it was last set.
 * Standard obstetric convention: EDD sits 40 weeks after LMP, so
 * (40 - weeksRemaining) gives the current week.
 */
export function resolveGestationalWeek(source: WeekSource | null | undefined): number | null {
  if (!source) return null;
  if (source.edd) {
    const due = new Date(source.edd);
    if (!Number.isNaN(due.getTime())) {
      const msPerWeek = 7 * 24 * 60 * 60 * 1000;
      const weeksRemaining = (due.getTime() - Date.now()) / msPerWeek;
      const week = Math.round(40 - weeksRemaining);
      if (week >= WEEK_MIN && week <= WEEK_MAX) return week;
    }
  }
  if (typeof source.pregnancy_week === "number" && source.pregnancy_week >= 0) {
    return source.pregnancy_week;
  }
  return null;
}
