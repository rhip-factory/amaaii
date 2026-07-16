// Danger-sign copy for the "Feeling unwell? Get help now" sheet.
//
// packages/core has no package.json (it's consumed via a TS path alias
// inside the single root tsconfig/vitest config, not as an installable
// workspace package — see packages/core/src/i18n.ts), and apps/web is a
// standalone Next.js app outside that alias graph. Per the P2-A brief
// ("source the copy from packages/core i18n exports if importable, else
// duplicate the strings verbatim"), this file duplicates the relevant
// strings verbatim from packages/core/src/i18n.ts (danger_critical /
// danger_high) and dangerSigns.ts (the human-readable `sign` labels).
// Keep in sync by hand if either file changes.

export interface DangerSignItem {
  en: string;
  sw: string;
}

// The most common CRITICAL/HIGH tier signs from
// packages/core/src/dangerSigns.ts, phrased for a mother reading a list
// rather than for regex matching.
export const DANGER_SIGN_LIST: DangerSignItem[] = [
  { en: "Heavy vaginal bleeding", sw: "Kutokwa na damu nyingi ukeni" },
  { en: "Severe headache with vision changes", sw: "Maumivu makali ya kichwa na mabadiliko ya kuona" },
  { en: "Convulsions or fainting", sw: "Kifafa au kuzimia" },
  { en: "Severe difficulty breathing", sw: "Shida kubwa ya kupumua" },
  { en: "Severe abdominal or chest pain", sw: "Maumivu makali ya tumbo au kifua" },
  { en: "Waters breaking before labour", sw: "Maji kuvunjika kabla ya uchungu" },
  { en: "No or reduced baby movement", sw: "Mtoto hatembei au anatembea kidogo" },
  { en: "High fever", sw: "Homa kali" },
  { en: "Severe swelling of face or hands", sw: "Uvimbe mkubwa wa uso au mikono" },
];

// Verbatim from packages/core/src/i18n.ts STRINGS.en.danger_critical /
// danger_high (the canned escalation copy the bot already sends).
export const EMERGENCY_COPY = {
  en: {
    heading: "This is a medical emergency",
    body: "Go to the nearest hospital or health centre now, or call 999 for an ambulance. If it's an emotional crisis, call Befrienders Kenya on 0722 178 177. Don't wait — tell someone and go now.",
  },
  sw: {
    heading: "Hii ni dharura ya kiafya",
    body: "Nenda kituo cha afya au hospitali ya karibu sasa hivi, au piga 999 kwa gari la wagonjwa. Kama ni shida ya kiakili, piga Befrienders Kenya 0722 178 177. Usisubiri — mwambie mtu na uende sasa.",
  },
} as const;

export const EMERGENCY_TEL = "tel:999";
export const CRISIS_TEL = "tel:0722178177";
