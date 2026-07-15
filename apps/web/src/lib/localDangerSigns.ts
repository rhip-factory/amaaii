// Offline-safe local danger-sign check (P2-D). CLINICALLY LOAD-BEARING —
// see item 5 of the P2-D design brief.
//
// Why this exists: an offline-queued journal entry only gets scanned by
// the real (server-side) danger-sign detector once the outbox flushes,
// which could be minutes or hours after the mother typed "heavy
// bleeding" into the form. That's not acceptable for a maternal-health
// app, so this duplicates just the CRITICAL and HIGH tiers of
// packages/core/src/dangerSigns.ts's DANGER_SIGNS — VERBATIM, same
// pattern source/flags and sign labels — so JournalCheckIn.tsx can show
// the coral escalation card + HelpSheet immediately, before the entry
// ever reaches the network.
//
// apps/web cannot import packages/core directly: packages/core has no
// package.json (consumed only via the root tsconfig/vitest path alias,
// which apps/web's standalone Next.js tsconfig doesn't share — see
// dangerSignsCopy.ts's header comment, same constraint, same fix). Per
// the P2-D brief this is duplicated by hand and pinned with a test
// (tests/offlineDangerSignsParity.test.ts) that imports BOTH this file
// and @amaaii/core and asserts the CRITICAL/HIGH pattern lists are
// identical — so the two can't silently drift. If you change a
// CRITICAL/HIGH pattern in packages/core/src/dangerSigns.ts, that test
// will fail until you copy the change here too.
//
// Deliberately CRITICAL/HIGH only — MODERATE-tier signs don't produce an
// escalation even server-side (see core's detectDangerSigns), so there's
// nothing for an offline-immediate check to add for that tier.

export interface LocalSignDefinition {
  pattern: RegExp;
  sign: string;
}

export const LOCAL_DANGER_SIGNS: Record<'CRITICAL' | 'HIGH', LocalSignDefinition[]> = {
  // Verbatim copy of packages/core/src/dangerSigns.ts DANGER_SIGNS.CRITICAL.signs.
  CRITICAL: [
    { pattern: /\bsevere\s+bleeding\b|\bheavy\s+bleeding\b|\bbleeding\s+(?:heavily|severely|a\s+lot|profusely)\b|\bblood\s+clots\b|\bgushing\s+blood\b|\bsoaking\s+(?:a\s+)?pad\b|\b(?:nina|na|me|ina)?(?:tokwa|vuja)\s+(?:na\s+)?damu\b|\bkutokwa\s+na\s+damu\b|\bkuvuja\s+damu\b|\bdamu\s+(?:nyingi|sana)\b/i, sign: 'Severe vaginal bleeding' },
    { pattern: /\bsevere\s+headache\b[^.]{0,40}\b(?:vision|seeing\s+spots|blurred)\b|\bvision\b[^.]{0,40}\bsevere\s+headache\b|\bseeing\s+spots\b|\bblurred\s+vision\b|\b\w*ona\s+(?:madoa|dots)\b|\bmacho\s+\w+ona\s+vibaya\b/i, sign: 'Severe headache with vision changes' },
    { pattern: /\bconvulsions?\b|\bseizures?\b|\bjerking\b|\bmshtuko\b|\bkifafa\b/i, sign: 'Convulsions or seizures' },
    { pattern: /\bpassed\s+out\b|\bunconscious\b|\bfainted\b|\bcollapsed\b|\b(?:nime|ali|ame)?zimia\b|\bkuzimia\b/i, sign: 'Loss of consciousness' },
    { pattern: /\bcan'?t\s+breathe\b|\bdifficulty\s+breathing\b|\bgasping\b|\bchoking\b|\bsiwezi\s+kupumua\b|\bshida\s+ya\s+kupumua\b/i, sign: 'Severe breathing difficulty' },
    { pattern: /\bsevere\s+chest\s+pain\b|\bcrushing\s+chest\b|\bheart\s+attack\b|\bmaumivu\s+(?:makali\s+)?ya\s+kifua\b/i, sign: 'Severe chest pain' },
    { pattern: /\bwaters?\s+(?:has\s+|have\s+|just\s+|already\s+)?(?:been\s+)?broke(?:n)?\b|\bwater\s+breaking\b|\bamniotic\s+fluid\b|\bfluid\s+gushing\b|\bgushing\s+fluid\b|\bfluid\s+down\s+(?:my\s+)?legs\b|\bmaji\s+yame(?:vunjika|pasuka)\b/i, sign: 'Rupture of membranes' },
    { pattern: /\bsuicide\b|\bkill\s+myself\b|\bwant\s+to\s+die\b|\bend\s+it\s+all\b|\bharm\s+myself\b|\bkujiua\b|\bnataka\s+kufa\b|\bkujidhuru\b/i, sign: 'Suicidal ideation' },
    { pattern: /\bhurt\s+the\s+baby\b|\bharm\s+the\s+baby\b|\bkill\s+the\s+baby\b|\bkumdhuru\s+mtoto\b|\bkumuua\s+mtoto\b/i, sign: 'Thoughts of harming baby' },
  ],
  // Verbatim copy of packages/core/src/dangerSigns.ts DANGER_SIGNS.HIGH.signs.
  HIGH: [
    { pattern: /\bbleeding\b|\bspotting\b|\bblood\s+clots\b|\bgushing\s+blood\b|\bsoaking\s+(?:a\s+)?pad\b|\bkutokwa\s+na\s+damu\b|\bkuvuja\s+damu\b|\b(?:nina|na|me|ina)?(?:tokwa|vuja)\s+damu\b/i, sign: 'Vaginal bleeding' },
    { pattern: /\bsevere\s+headache\b|\bterrible\s+headache\b|\bworst\s+headache\b|\bkichwa\s+(?:kina|ya|kin)(?:ni)?(?:uma)\s+(?:sana|vibaya|mno)\b|\bmaumivu\s+(?:makali|mengi)\s+ya\s+kichwa\b/i, sign: 'Severe headache' },
    { pattern: /\bfever\b|\bhigh\s+temperature\b|\bburning\s+up\b|\b3[89](?:\.\d+)?\s*°?\s*c\b|\b10[0-9](?:\.\d+)?\s*°?\s*f\b|\bhoma\b|\bjoto\s+kali\b/i, sign: 'Fever' },
    { pattern: /\bsevere\s+pain\b|\bterrible\s+pain\b|\bunbearable\s+pain\b|\bmaumivu\s+makali\b/i, sign: 'Severe pain' },
    { pattern: /\bpersistent\s+vomiting\b|\bcan'?t\s+keep\b[^.]{0,20}\bdown\b|\bthrowing\s+up\s+constantly\b|\bkutapika\s+(?:sana|mfululizo|mara\s+nyingi)\b|\b(?:nina|me|na)tapika\s+(?:sana|mfululizo)\b/i, sign: 'Persistent vomiting' },
    { pattern: /\b(?:swelling|swollen|puffy)\b[^.]{0,15}\bface\b|\bface\b[^.]{0,15}\b(?:swelling|swollen|puffy)\b|\buso\s+(?:\w+\s+)?ume(?:vimba|vimbiwa)\b|\buvimbe\s+(?:wa\s+)?uso\b/i, sign: 'Facial swelling' },
    { pattern: /\b(?:swelling|swollen|puffy)\b[^.]{0,15}\bhands?\b|\bhands?\b[^.]{0,20}\b(?:swelling|swollen|puffy)\b|\bmikono\s+(?:\w+\s+)?ime(?:vimba|vimbiwa)\b|\buvimbe\s+(?:wa\s+)?mikono\b/i, sign: 'Hand swelling' },
    { pattern: /\bbaby\s+(?:has|have|hasn'?t|haven'?t|is|isn'?t)?(?:\s+been)?\s+not\s+(?:been\s+)?moving\b|\bbaby\s+(?:hasn'?t|haven'?t|isn'?t)\s+(?:been\s+)?moving\b|\bbaby\s+not\s+moving\b|\bno\s+(?:fetal\s+)?movement\b|\bhaven'?t\s+felt\b[^.]{0,30}\bbaby\b|\b(?:haven'?t|hasn'?t|isn'?t|not)\s+(?:been\s+)?(?:feeling|felt|feel)\s+(?:the\s+)?baby\s+(?:move|moving)\b|\bdecreased\s+movement\b|\bbaby\s+(?:moved|moving)\s+less\b|\bless\s+(?:fetal\s+)?movement\b|\bmtoto\s+ha(?:tembei|jatembea)\b|\bsijahisi\s+mtoto\b|\bmtoto\s+hatembei\s+sana\b/i, sign: 'Reduced fetal movement' },
    { pattern: /\bsudden\s+weight\s+gain\b|\bgained\b[^.]{0,15}\b(?:pounds|kg|kilos)\b[^.]{0,15}\bweek\b/i, sign: 'Sudden weight gain' },
  ],
};

export interface LocalDangerResult {
  urgencyLevel: 'critical' | 'high' | 'low';
  detectedSigns: { sign: string; level: 'critical' | 'high' }[];
}

// Same tier-priority walk as core's detectDangerSigns (CRITICAL beats
// HIGH, first CRITICAL hit short-circuits), restricted to the two tiers
// this file carries.
export function detectLocalDangerSigns(message: string): LocalDangerResult {
  const detectedSigns: LocalDangerResult['detectedSigns'] = [];
  let urgencyLevel: LocalDangerResult['urgencyLevel'] = 'low';

  for (const level of ['CRITICAL', 'HIGH'] as const) {
    for (const { pattern, sign } of LOCAL_DANGER_SIGNS[level]) {
      if (pattern.test(message)) {
        const tierLevel = level.toLowerCase() as 'critical' | 'high';
        detectedSigns.push({ sign, level: tierLevel });
        if (level === 'CRITICAL') {
          urgencyLevel = 'critical';
        } else if (urgencyLevel !== 'critical') {
          urgencyLevel = 'high';
        }
      }
    }
    if (urgencyLevel === 'critical') break;
  }

  return { detectedSigns, urgencyLevel };
}
