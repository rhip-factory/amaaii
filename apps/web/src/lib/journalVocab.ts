// Structured check-in form vocabulary (P2-C).
//
// packages/core has no package.json (it's consumed via a TS path alias
// inside the single root tsconfig/vitest config, not as an installable
// workspace package — see packages/core/src/i18n.ts), and apps/web is a
// standalone Next.js app outside that alias graph — same reason
// src/lib/dangerSignsCopy.ts duplicates i18n copy instead of importing it.
// This file duplicates the symptom vocabulary verbatim from
// packages/core/src/dangerSigns.ts's SYMPTOM_VALUES / extractSymptoms
// (the canonical Symptom union in packages/core/src/types.ts) and the
// AppetiteLevel enum ('good' | 'moderate' | 'poor' — NOT 'fair'). Keep in
// sync by hand if either changes.

export interface SymptomOption {
  value: string;
  en: string;
  sw: string;
}

// Order matches packages/core/src/dangerSigns.ts's SYMPTOM_VALUES.
export const SYMPTOM_OPTIONS: SymptomOption[] = [
  { value: "nausea", en: "Nausea", sw: "Kichefuchefu" },
  { value: "vomiting", en: "Vomiting", sw: "Kutapika" },
  { value: "headache", en: "Headache", sw: "Maumivu ya kichwa" },
  { value: "back_pain", en: "Back pain", sw: "Maumivu ya mgongo" },
  { value: "cramping", en: "Cramping", sw: "Minyong'onyo" },
  { value: "bleeding", en: "Bleeding", sw: "Kutokwa na damu" },
  { value: "swelling", en: "Swelling", sw: "Uvimbe" },
  { value: "fatigue", en: "Fatigue", sw: "Uchovu" },
  { value: "dizziness", en: "Dizziness", sw: "Kizunguzungu" },
  { value: "constipation", en: "Constipation", sw: "Kuvimbiwa" },
  { value: "heartburn", en: "Heartburn", sw: "Kiungulia" },
  { value: "insomnia", en: "Trouble sleeping", sw: "Shida ya kulala" },
];

// Real enum from packages/core/src/types.ts AppetiteLevel — NOT
// 'good'/'fair'/'poor'. Verified against parseAppetiteAnswer() in
// packages/core/src/journal.ts before wiring this up.
export interface AppetiteOption {
  value: "good" | "moderate" | "poor";
  en: string;
  sw: string;
}

export const APPETITE_OPTIONS: AppetiteOption[] = [
  { value: "good", en: "Good", sw: "Nzuri" },
  { value: "moderate", en: "Moderate", sw: "Wastani" },
  { value: "poor", en: "Poor", sw: "Mbaya" },
];
