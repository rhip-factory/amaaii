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

// Verbatim copy of the neutralizers in packages/core/src/dangerSigns.ts
// (negated / resolved / hypothetical mentions are rewritten to " none "
// before matching). Pinned by tests/offlineDangerSignsParity.test.ts.
const NEG_SYMPTOM = '(?:(?:heavy|severe|vaginal|bad|terrible|any)\\s+)?(?:bleeding|spotting|blood|fever|headaches?|pain|cramps?|cramping|swelling|discharge|vomiting|seizures?|convulsions?|dizziness|blurr(?:ed|y)\\s+vision|vision\\s+(?:problems?|changes?)|hot\\s+(?:or\\s+hard\\s+)?breasts?|contractions?|damu(?:\\s+(?:nyingi|chini))?|homa|maumivu(?:\\s+(?:makali|ya\\s+\\w+))?|kichwa|kifua|uvimbe|kizunguzungu|cracks?|discomfort)\\b(?:\\s+(?:at\\s+all|whatsoever|either|anymore|tena|today|leo|sasa))?';
const NEGATOR = '(?:no|never(?:\\s+had)?|without|hakuna|sina|bila|sijapata|sijaona|sijatokwa(?:\\s+na)?|(?:don\'?t|do\\s+not|didn\'?t|did\\s+not|haven\'?t|have\\s+not|hasn\'?t|has\\s+not|not)(?:\\s+(?:actually|really))?(?:\\s+(?:have|had|seen|see|got|noticed|felt|experienced))?)';
const NEG_FILL = '(?:\\s+(?:any|a|an|more|much|real))*\\s+';
const NEG_LIST_TAIL = `(?:(?:\\s*[,/]?\\s*(?:or|nor|wala|au)\\s+|\\s*(?:[,;/&]|\\band\\b|\\bna\\b)?\\s*\\b${NEGATOR}${NEG_FILL})${NEG_SYMPTOM})*`;
const HYPOTHETICAL = '(?:nikipata|nikitokwa(?:\\s+na)?|nikianza(?:\\s+kutokwa(?:\\s+na)?)?|nikiona|(?:if|in\\s+case)\\s+(?:i|you|she)\\s+(?:get|gets|start|starts|see|sees|have|has|notice|notices)(?:\\s+(?:any|a|some))?)\\s+';
const SELF_HARM_NEGATOR = '(?:sijafikiria|sijawaza|never\\s+thought\\s+(?:of|about)|not\\s+thinking\\s+(?:of|about)|(?:don\'?t|do\\s+not)\\s+want\\s+to|would\\s+never|wouldn\'?t|i\'?m\\s+not\\s+going\\s+to)';
const SELF_HARM_ITEM = '(?:kujiumiza|kujiua|kujidhuru|kumdhuru\\s+mtoto|kumuua\\s+mtoto|(?:hurt|harm|kill)(?:ing)?\\s+(?:myself|the\\s+baby|my\\s+baby|anyone|him|her))';

export interface LocalTriageNeutralizer {
  pattern: RegExp;
  replacement: string;
}

export const LOCAL_TRIAGE_NEUTRALIZERS: LocalTriageNeutralizer[] = [
  // Place name: "Homa Bay" (county) is not "homa" (fever).
  { pattern: /\bhoma\s*bay\b/gi, replacement: 'homabay' },
  // Bleeding that is not vaginal: cracked nipples, gums, nose.
  { pattern: /\b(nipples?|gums?|nose)\b([^.?!]{0,30}?)\bbleed(?:ing|s)?\b/gi, replacement: '$1$2sore' },
  // Resolved: "homa imeisha", "the bleeding stopped", "fever is gone",
  // "the spotting is nothing serious" (a clinician's reassurance).
  { pattern: /\b(?:homa|damu|bleeding|fever|spotting|pain|maumivu)\s+(?:imeisha|imekwisha|haipo|imepungua|imeacha|ikirudi|has\s+stopped|stopped|is\s+gone|has\s+gone|went\s+away|(?:is|was)\s+nothing\s+serious)\b/gi, replacement: ' none ' },
  // Normal postpartum lochia: "normal/light/lochia bleeding", "the bleeding
  // is the normal one". "heavy bleeding" is deliberately not covered.
  { pattern: /\b(?:normal|light|lochia|after-?birth)\s+(?:lochia\s+)?bleeding\b|\bthe\s+bleeding\s+is\s+(?:still\s+)?(?:the\s+normal|normal|light)\b/gi, replacement: ' none ' },
  // Someone else's symptom: "dada yangu alipata spotting", "my sister had
  // spotting".
  { pattern: new RegExp(`\\b(?:my\\s+(?:sister|friend|mum|mother|cousin|neighbou?r)|dada\\s+yangu|rafiki\\s+yangu|mama\\s+yangu)\\b(?:\\s+\\w+){0,2}?\\s+(?:had|got|has|alipata|alikuwa\\s+na|ana)\\s+(?:a\\s+|some\\s+|kidogo\\s+)?${NEG_SYMPTOM}`, 'gi'), replacement: ' none ' },
  // "I haven't fainted" (sijazimia).
  { pattern: /\bsijazimia\b/gi, replacement: ' none ' },
  // A question about a medicine, not a thought of harm: "dawa ya malaria
  // inaweza kumdhuru mtoto?" ("can the malaria drug harm the baby?").
  { pattern: /\b(?:dawa|medicine|medication|drug|tablets?|pills?|ultrasound|x-?ray|scan)\b(?:\s+\w+){0,4}?\s+(?:inaweza|itaweza|can|could|will|might)\s+(?:kumdhuru|kudhuru|harm|hurt)\s+(?:the\s+|my\s+)?(?:mtoto|baby)\b|\b(?:can|could|will|might|does|is)\s+(?:this|that|the|my)\s+(?:\w+\s+){0,2}?(?:medicine|medication|drug|tablets?|pills?|ultrasound|x-?ray|scan|injection|vaccine)\s+(?:harm|hurt)\s+(?:the\s+|my\s+)?baby\b|\b(?:can|could|will|might|does|would)\s+(?:it|this|that|the\s+\w+)\s+(?:also\s+)?(?:hurt|harm)\s+(?:the\s+|my\s+)?baby\b|\b(?:the|this|that)\s+\w+\s+(?:can|could|will|might)\s+(?:also\s+)?(?:hurt|harm)\s+(?:the\s+|my\s+)?baby\b/gi, replacement: ' none ' },
  // Negated self-harm: "sijafikiria kujiumiza wala kumdhuru mtoto".
  { pattern: new RegExp(`\\b${SELF_HARM_NEGATOR}\\s+${SELF_HARM_ITEM}(?:\\s*(?:,|or|nor|wala|au)\\s+${SELF_HARM_ITEM})*`, 'gi'), replacement: ' none ' },
  // Hypothetical: "nikipata homa au damu nyingi nitaenda", "if I get bleeding".
  { pattern: new RegExp(`\\b${HYPOTHETICAL}${NEG_SYMPTOM}${NEG_LIST_TAIL}`, 'gi'), replacement: ' none ' },
  // Negated: "no bleeding at all and no headache", "sina homa wala damu".
  { pattern: new RegExp(`\\b${NEGATOR}${NEG_FILL}${NEG_SYMPTOM}${NEG_LIST_TAIL}`, 'gi'), replacement: ' none ' },
];

export function neutralizeLocalForTriage(message: string): string {
  return LOCAL_TRIAGE_NEUTRALIZERS.reduce((text, n) => text.replace(n.pattern, n.replacement), message);
}

export const LOCAL_DANGER_SIGNS: Record<'CRITICAL' | 'HIGH', LocalSignDefinition[]> = {
  // Verbatim copy of packages/core/src/dangerSigns.ts DANGER_SIGNS.CRITICAL.signs.
  CRITICAL: [
    { pattern: /\bsevere\s+bleeding\b|\bheavy\s+bleeding\b|\bbleeding\s+(?:heavily|severely|a\s+lot|profusely)\b|\bblood\s+clots\b|\bgushing\s+blood\b|\bsoak(?:ed|ing)\s+(?:through\s+)?(?:\w+\s+)?pads?\b|\b(?:nina|na|me|ina)?(?:tokwa|vuja)\s+(?:na\s+)?damu\b|\bkutokwa\s+na\s+damu\b|\bkuvuja\s+damu\b|\bdamu\s+(?:nyingi|sana)\b|\bdamu\s+\w*toka\s+(?:nyingi|sana)\b|\b\w*lowe(?:ka|sha)\s+(?:pedi|pads?)\b/i, sign: 'Severe vaginal bleeding' },
    { pattern: /\bsevere\s+headache\b[^.]{0,40}\b(?:vision|seeing\s+spots|blurred)\b|\bvision\b[^.]{0,40}\bsevere\s+headache\b|\bseeing\s+(?:\w+\s+)?(?:spots|stars|lights)\b|\bflashing\s+(?:lights|spots)\b|\bblurr(?:ed|y)\s+vision\b|\bvision\s+(?:is\s+)?blurr(?:ed|y)\b|\b\w*ona\s+(?:madoa|dots)\b|\bmacho\s+\w+ona\s+vibaya\b/i, sign: 'Severe headache with vision changes' },
    { pattern: /\b(?:1[6-9]\d|2\d\d)\s*(?:\/|over)\s*\d{2,3}\b|\b\d{2,3}\s*(?:\/|over)\s*1[1-9]\d\b/i, sign: 'Severe-range blood pressure' },
    { pattern: /\bconvulsions?\b|\bseizures?\b|\bjerking\b|\bmshtuko\b|\bkifafa\b/i, sign: 'Convulsions or seizures' },
    { pattern: /\bpassed\s+out\b|\bunconscious\b|\bfainted\b|\bcollapsed\b|\b\w{0,5}zimia\b/i, sign: 'Loss of consciousness' },
    { pattern: /\bcan'?t\s+breathe\b|\bdifficulty\s+breathing\b|\bgasping\b|\bchoking\b|\bsiwezi\s+kupumua\b|\bshida\s+ya\s+kupumua\b/i, sign: 'Severe breathing difficulty' },
    { pattern: /\bsevere\s+chest\s+pain\b|\bcrushing\s+chest\b|\bheart\s+attack\b|\bmaumivu\s+(?:makali\s+)?ya\s+kifua\b/i, sign: 'Severe chest pain' },
    { pattern: /\bwaters?\s+(?:has\s+|have\s+|just\s+|already\s+)?(?:been\s+)?broke(?:n)?\b|\bwater\s+breaking\b|\bamniotic\s+fluid\b|\bfluid\s+gushing\b|\bgushing\s+fluid\b|\bfluid\s+down\s+(?:my\s+)?legs\b|\b(?:water|fluid)\b[^.]{0,30}\bgush(?:ed|ing|es)\b|\bgush(?:ed|ing)\b[^.]{0,20}\bdown\s+(?:my\s+)?legs\b|\bmaji\s+yame(?:vunjika|pasuka)\b|\bmaji\s+(?:mengi\s+)?yame(?:ni)?(?:toka|mwagika)\b/i, sign: 'Rupture of membranes' },
    { pattern: /\bsuicide\b|\bkill\s+myself\b|\bwant\s+to\s+die\b|\bend\s+it\s+all\b|\bharm\s+myself\b|\bkujiua\b|\bnataka\s+kufa\b|\bkujidhuru\b|\bbetter\s+off\s+without\s+me\b|\bwish\s+i\s+(?:could\s+)?(?:just\s+)?(?:disappear|die|was\s+dead|wasn'?t\s+here)\b|\b(?:sleep|go\s+to\s+sleep)\s+and\s+(?:never|not)\s+wake\s+up\b|\bno\s+reason\s+to\s+live\b|\b(?:don'?t|do\s+not)\s+want\s+to\s+(?:be\s+alive|live|exist)\b|\bsitaki\s+kuishi\b|\bnatamani\s+(?:nife|kufa)\b|\bningependa\s+kufa\b|\bnijiue\b/i, sign: 'Suicidal ideation' },
    { pattern: /\bhurt\s+the\s+baby\b|\bharm\s+the\s+baby\b|\bkill\s+the\s+baby\b|\bkumdhuru\s+mtoto\b|\bkumuua\s+mtoto\b/i, sign: 'Thoughts of harming baby' },
    { pattern: /\bbaby\s+(?:is\s+)?(?:not|isn'?t)\s+breathing\b|\bbaby\b[^.]{0,20}\b(?:turning|turned|is|looks)\s+blue\b|\bmtoto\s+hapumui\b/i, sign: 'Newborn not breathing / blue' },
  ],
  // Verbatim copy of packages/core/src/dangerSigns.ts DANGER_SIGNS.HIGH.signs.
  HIGH: [
    { pattern: /\bbleeding\b|\bspotting\b|\bblood\s+clots\b|\bgushing\s+blood\b|\bsoaking\s+(?:a\s+)?pad\b|\bkutokwa\s+na\s+damu\b|\bkuvuja\s+damu\b|\b(?:nina|na|me|ina)?(?:tokwa|vuja)\s+damu\b|\b(?:ni|na|nina|nili|ali|ana|ime|ina|me)?toka\s+damu\b|\b(?:saw|seen|see|noticed|found)\s+(?:a\s+)?(?:little\s+|some\s+|bit\s+of\s+)?blood\b|\bblood\s+(?:on|in)\s+(?:my\s+)?(?:underwear|pant\w*|pad|tissue|knickers)\b|\b\w*ona\s+damu\b|\bdamu\s+kidogo\b/i, sign: 'Vaginal bleeding' },
    { pattern: /\bsevere\s+headache\b|\bterrible\s+headache\b|\bworst\s+headache\b|\bkichwa\s+(?:kina|ya|kin)(?:ni)?(?:uma)\s+(?:sana|vibaya|mno)\b|\bmaumivu\s+(?:makali|mengi)\s+ya\s+kichwa\b/i, sign: 'Severe headache' },
    { pattern: /\b1[45]\d\s*(?:\/|over)\s*\d{2,3}\b|\b\d{2,3}\s*(?:\/|over)\s*(?:9\d|10\d)\b/i, sign: 'Raised blood pressure' },
    { pattern: /\bfever\b|\bhigh\s+temperature\b|\bburning\s+up\b|\b3[89](?:\.\d+)?\s*°?\s*c\b|\b10[0-9](?:\.\d+)?\s*°?\s*f\b|\bhoma\b|\bjoto\s+kali\b/i, sign: 'Fever' },
    { pattern: /\bsevere\s+pain\b|\bterrible\s+pain\b|\bunbearable\s+pain\b|\bmaumivu\s+makali\b/i, sign: 'Severe pain' },
    { pattern: /\b(?:pains?|contractions?|cramps?)\s+(?:coming\s+)?every\s+\d+\s*(?:-\s*\d+\s*)?(?:min|mins|minutes)\b|\bmaumivu\s+(?:\w+\s+){0,2}kila\s+dakika\b|\bmaumivu\s+(?:ya\s+)?uchungu\b/i, sign: 'Regular contractions' },
    { pattern: /\bpersistent\s+vomiting\b|\bcan'?t\s+keep\b[^.]{0,20}\bdown\b|\bthrowing\s+up\s+constantly\b|\bvomiting\s+every\s+(?:hour|time)\b|\bkutapika\s+(?:sana|mfululizo|mara\s+nyingi)\b|\b(?:nina|me|na)tapika\s+(?:sana|mfululizo)\b|\b\w*tapika\s+kila\s+(?:saa|wakati|mara)\b|\b(?:siwezi|sijaweza)\s+(?:hata\s+)?kunywa\s+(?:hata\s+)?maji\b/i, sign: 'Persistent vomiting' },
    { pattern: /\b(?:swelling|swollen|puffy)\b[^.]{0,15}\bface\b|\bface\b[^.]{0,15}\b(?:swelling|swollen|puffy)\b|\buso\s+(?:\w+\s+)?ume(?:vimba|vimbiwa)\b|\buvimbe\s+(?:wa\s+)?uso\b/i, sign: 'Facial swelling' },
    { pattern: /\b(?:swelling|swollen|puffy)\b[^.]{0,15}\bhands?\b|\bhands?\b[^.]{0,20}\b(?:swelling|swollen|puffy)\b|\bmikono\s+(?:\w+\s+)?ime(?:vimba|vimbiwa)\b|\buvimbe\s+(?:wa\s+)?mikono\b/i, sign: 'Hand swelling' },
    { pattern: /\bbaby\s+(?:has|have|hasn'?t|haven'?t|is|isn'?t)?(?:\s+been)?\s+not\s+(?:been\s+)?moving\b|\bbaby\s+(?:hasn'?t|haven'?t|isn'?t)\s+(?:been\s+)?moving\b|\bbaby\s+not\s+moving\b|\bno\s+(?:fetal\s+)?movement\b|\bhaven'?t\s+felt\b[^.]{0,30}\bbaby\b|\b(?:haven'?t|hasn'?t|isn'?t|not)\s+(?:been\s+)?(?:feeling|felt|feel)\s+(?:the\s+)?baby\s+(?:move|moving)\b|\bdecreased\s+movement\b|\bbaby\s+(?:moved|moving)\s+less\b|\bless\s+(?:fetal\s+)?movement\b|\bmoving\s+(?:much\s+|a\s+lot\s+|way\s+|really\s+)?less\b|\b(?:baby|she|he)\s+(?:has\s+not|hasn'?t|did\s+not|didn'?t|has\s+stopped|stopped)\s+(?:moved|moving|kicking|kicked)\b|\b(?:only\s+)?(?:a\s+)?few\s+kicks\b|\bfewer\s+kicks\b|\bnot\s+kicking\b|\bmtoto\s+ha(?:tembei|jatembea)\b|\bsijahisi\s+mtoto\b|\bmtoto\s+hatembei\s+sana\b|\bhasongi\b|\bhachezi\b|\bhaja(?:cheza|songa)\b|\bhapigi\s+teke\b|\b(?:ana)?(?:songa|cheza)\s+kidogo\b/i, sign: 'Reduced fetal movement' },
    { pattern: /\bsudden\s+weight\s+gain\b|\bgained\b[^.]{0,15}\b(?:pounds|kg|kilos)\b[^.]{0,15}\bweek\b/i, sign: 'Sudden weight gain' },
    { pattern: /\b(?:husband|partner|boyfriend|he)\b[^.]{0,20}\b(?:hit|beat|kicked|punched|slapped|pushed)\s+me\b|\b(?:ali|ame|ana)nipiga\b|\b(?:nime|nili)anguka\b|\bi\s+fell\s+(?:down|over|on|off|hard)\b|\bfell\s+on\s+my\s+(?:belly|stomach|tummy)\b/i, sign: 'Violence or fall' },
    { pattern: /\bbaby\b[^.]{0,30}\b(?:not\s+feeding|won'?t\s+(?:feed|breastfeed|latch|suck)|refus\w*\s+to\s+(?:feed|breastfeed)|very\s+yellow|yellow\s+(?:skin|eyes)|floppy|breathing\s+(?:very\s+)?fast)\b|\bmtoto\s+(?:hanyonyi|hataki\s+kunyonya|ana\s+manjano)\b|\bcord\b[^.]{0,20}\b(?:pus|smell\w*)\b|\bkitovu\b[^.]{0,20}\b(?:usaha|harufu)\b/i, sign: 'Newborn danger sign' },
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
  const text = neutralizeLocalForTriage(message);
  const detectedSigns: LocalDangerResult['detectedSigns'] = [];
  let urgencyLevel: LocalDangerResult['urgencyLevel'] = 'low';

  for (const level of ['CRITICAL', 'HIGH'] as const) {
    for (const { pattern, sign } of LOCAL_DANGER_SIGNS[level]) {
      if (pattern.test(text)) {
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
