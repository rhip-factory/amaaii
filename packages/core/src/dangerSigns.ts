// Pattern conventions (per AMAAII_PHASE_0_SPEC §7.3):
// - All keyword patterns use \b word boundaries.
// - HIGH tier no longer matches bare "blood" (false positives on
//   "blood pressure", "blood test", "bloodwork").
// - "tired|exhausted|fatigued" only match when preceded by a recognised
//   pronoun/symptom-verb token AND not followed by "of".
// - "fluid"/"leaking" require a clinical prefix (gushing/losing/watery)
//   or bodily-context suffix (from vagina / down my legs).
// - "discharge" matches when qualified or as the bare word
//   (\bdischarge\b — does not match "discharged").
//
// Kiswahili coverage (added Phase B+):
// - Triage MUST be language-agnostic — an LLM "deciding" urgency for
//   non-English users would be a safety hole (spec §6.2). Every tier
//   below carries Kiswahili variants alongside the English regexes.
// - We use lowercase keywords with \b boundaries; SW grammar is mostly
//   agglutinative (prefixes like ni-/u-/me-/na-) so we match the root
//   stem when safe.
//
// CLINICALLY LOAD-BEARING: this file began as a verbatim port of the
// original services/dangerSigns.js. Since the 2026-10 mother simulation
// it also (a) neutralizes negated / resolved / hypothetical mentions
// before matching (TRIAGE_NEUTRALIZERS below) and (b) carries extra
// patterns mined from that run's real phrasings. Behaviour is pinned by
// tests/fixtures/danger-signs-golden.json (tests/dangerSigns.test.js);
// the CRITICAL/HIGH tiers AND the neutralizers are mirrored verbatim in
// apps/web/src/lib/localDangerSigns.ts (tests/offlineDangerSignsParity.test.ts).

import type { DangerSignResult, DetectedSign, Mood, Symptom, Urgency } from './types';
import { parseSqliteUtc } from './commands';

const TIRED_PRECEDENT = '(?:i\'?m|i\\s+am|am|i\\s+feel|feel|feeling|so|very|extremely)';
const TIRED_INTENSIFIER = '(?:so\\s+|very\\s+|extremely\\s+|really\\s+)?';

// ---------------------------------------------------------------------------
// Neutralizers — run over the message BEFORE any danger pattern is tested.
//
// The simulation's biggest false-alarm class was mothers *denying* a symptom
// ("no bleeding, no headache") and then getting the "go to the clinic today"
// copy again and again. These rewrite a symptom word to " none " only when it
// is unambiguously negated, resolved or hypothetical:
//   - a negator sits DIRECTLY before the symptom (only filler words like
//     "any"/"actually seen" in between). "not sure if it's bleeding" and
//     "no, I'm bleeding" (comma) are NOT neutralized.
//   - a list continues only through "or/nor/wala/au", or through a separator
//     followed by another negator ("no pain and no bleeding"). "no pain and
//     bleeding heavily" stops after "pain", so the bleeding still escalates.
//   - movement words are never in the symptom list: "no movement" / "not
//     moving" ARE danger signs.
// When in doubt, leave the symptom in — a false alarm is cheaper than a miss.
// ---------------------------------------------------------------------------
const NEG_SYMPTOM = '(?:(?:heavy|severe|vaginal|bad|terrible|any)\\s+)?(?:bleeding|spotting|blood|fever|headaches?|pain|cramps?|cramping|swelling|discharge|vomiting|seizures?|convulsions?|dizziness|blurr(?:ed|y)\\s+vision|vision\\s+(?:problems?|changes?)|hot\\s+(?:or\\s+hard\\s+)?breasts?|contractions?|damu(?:\\s+(?:nyingi|chini))?|homa|maumivu(?:\\s+(?:makali|ya\\s+\\w+))?|kichwa|kifua|uvimbe|kizunguzungu|cracks?|discomfort)\\b(?:\\s+(?:at\\s+all|whatsoever|either|anymore|tena|today|leo|sasa))?';
const NEGATOR = '(?:no|never(?:\\s+had)?|without|hakuna|sina|bila|sijapata|sijaona|sijatokwa(?:\\s+na)?|(?:don\'?t|do\\s+not|didn\'?t|did\\s+not|haven\'?t|have\\s+not|hasn\'?t|has\\s+not|not)(?:\\s+(?:actually|really))?(?:\\s+(?:have|had|seen|see|got|noticed|felt|experienced))?)';
const NEG_FILL = '(?:\\s+(?:any|a|an|more|much|real))*\\s+';
const NEG_LIST_TAIL = `(?:(?:\\s*[,/]?\\s*(?:or|nor|wala|au)\\s+|\\s*(?:[,;/&]|\\band\\b|\\bna\\b)?\\s*\\b${NEGATOR}${NEG_FILL})${NEG_SYMPTOM})*`;
const HYPOTHETICAL = '(?:nikipata|nikitokwa(?:\\s+na)?|nikianza(?:\\s+kutokwa(?:\\s+na)?)?|nikiona|(?:if|in\\s+case)\\s+(?:i|you|she)\\s+(?:get|gets|start|starts|see|sees|have|has|notice|notices)(?:\\s+(?:any|a|some))?)\\s+';
const SELF_HARM_NEGATOR = '(?:sijafikiria|sijawaza|never\\s+thought\\s+(?:of|about)|not\\s+thinking\\s+(?:of|about)|(?:don\'?t|do\\s+not)\\s+want\\s+to|would\\s+never|wouldn\'?t|i\'?m\\s+not\\s+going\\s+to)';
const SELF_HARM_ITEM = '(?:kujiumiza|kujiua|kujidhuru|kumdhuru\\s+mtoto|kumuua\\s+mtoto|(?:hurt|harm|kill)(?:ing)?\\s+(?:myself|the\\s+baby|my\\s+baby|anyone|him|her))';

export interface TriageNeutralizer {
  pattern: RegExp;
  replacement: string;
}

export const TRIAGE_NEUTRALIZERS: TriageNeutralizer[] = [
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

export function neutralizeForTriage(message: string): string {
  return TRIAGE_NEUTRALIZERS.reduce((text, n) => text.replace(n.pattern, n.replacement), message);
}

interface SignDefinition {
  pattern: RegExp;
  sign: string;
}

interface DangerCategory {
  signs: SignDefinition[];
  response: string;
}

type DangerLevelKey = 'CRITICAL' | 'HIGH' | 'MODERATE';

export const DANGER_SIGNS: Record<DangerLevelKey, DangerCategory> = {
  CRITICAL: {
    signs: [
      // Bleeding (severe). EN: severe/heavy bleeding, blood clots, soaked pads.
      // SW: "kutokwa na damu" (bleeding), "ninavuja damu" (I'm bleeding),
      //     "damu nyingi" (a lot of blood), "damu inatoka nyingi",
      //     "nimelowesha/nimeloweka pedi" (I've soaked pads).
      { pattern: /\bsevere\s+bleeding\b|\bheavy\s+bleeding\b|\bbleeding\s+(?:heavily|severely|a\s+lot|profusely)\b|\bblood\s+clots\b|\bgushing\s+blood\b|\bsoak(?:ed|ing)\s+(?:through\s+)?(?:\w+\s+)?pads?\b|\b(?:nina|na|me|ina)?(?:tokwa|vuja)\s+(?:na\s+)?damu\b|\bkutokwa\s+na\s+damu\b|\bkuvuja\s+damu\b|\bdamu\s+(?:nyingi|sana)\b|\bdamu\s+\w*toka\s+(?:nyingi|sana)\b|\b\w*lowe(?:ka|sha)\s+(?:pedi|pads?)\b/i, sign: 'Severe vaginal bleeding' },

      // Severe headache + vision changes, or visual disturbance alone.
      // SW: kuona/ninaona/anaona/unaona madoa (any tense/person of "see");
      // macho yanaona vibaya. The \w*ona prefix catches any conjugation
      // since "ona" is the SW root for "see".
      { pattern: /\bsevere\s+headache\b[^.]{0,40}\b(?:vision|seeing\s+spots|blurred)\b|\bvision\b[^.]{0,40}\bsevere\s+headache\b|\bseeing\s+(?:\w+\s+)?(?:spots|stars|lights)\b|\bflashing\s+(?:lights|spots)\b|\bblurr(?:ed|y)\s+vision\b|\bvision\s+(?:is\s+)?blurr(?:ed|y)\b|\b\w*ona\s+(?:madoa|dots)\b|\bmacho\s+\w+ona\s+vibaya\b/i, sign: 'Severe headache with vision changes' },

      // Severe-range blood pressure: systolic >= 160 or diastolic >= 110,
      // written "165/112" or "165 over 112".
      { pattern: /\b(?:1[6-9]\d|2\d\d)\s*(?:\/|over)\s*\d{2,3}\b|\b\d{2,3}\s*(?:\/|over)\s*1[1-9]\d\b/i, sign: 'Severe-range blood pressure' },

      // SW: "mshtuko" (seizure/shock), "kifafa" (epilepsy/fits).
      { pattern: /\bconvulsions?\b|\bseizures?\b|\bjerking\b|\bmshtuko\b|\bkifafa\b/i, sign: 'Convulsions or seizures' },
      // SW: "nimezimia"/"nilizimia" (I fainted), "kuzimia" (to faint).
      { pattern: /\bpassed\s+out\b|\bunconscious\b|\bfainted\b|\bcollapsed\b|\b\w{0,5}zimia\b/i, sign: 'Loss of consciousness' },
      // SW: "siwezi kupumua" (I can't breathe), "shida ya kupumua" (breathing difficulty).
      { pattern: /\bcan'?t\s+breathe\b|\bdifficulty\s+breathing\b|\bgasping\b|\bchoking\b|\bsiwezi\s+kupumua\b|\bshida\s+ya\s+kupumua\b/i, sign: 'Severe breathing difficulty' },
      // SW: "maumivu makali ya kifua" (severe chest pain).
      { pattern: /\bsevere\s+chest\s+pain\b|\bcrushing\s+chest\b|\bheart\s+attack\b|\bmaumivu\s+(?:makali\s+)?ya\s+kifua\b/i, sign: 'Severe chest pain' },

      // Rupture of membranes. EN: "water broke", "water has broken",
      // "water just broke", "waters have broken" (UK English common in
      // Kenya), "water gushed down my legs". SW: "maji yamevunjika" /
      // "yamepasuka" / "maji yamenitoka".
      { pattern: /\bwaters?\s+(?:has\s+|have\s+|just\s+|already\s+)?(?:been\s+)?broke(?:n)?\b|\bwater\s+breaking\b|\bamniotic\s+fluid\b|\bfluid\s+gushing\b|\bgushing\s+fluid\b|\bfluid\s+down\s+(?:my\s+)?legs\b|\b(?:water|fluid)\b[^.]{0,30}\bgush(?:ed|ing|es)\b|\bgush(?:ed|ing)\b[^.]{0,20}\bdown\s+(?:my\s+)?legs\b|\bmaji\s+yame(?:vunjika|pasuka)\b|\bmaji\s+(?:mengi\s+)?yame(?:ni)?(?:toka|mwagika)\b/i, sign: 'Rupture of membranes' },

      // Self-harm, including passive ideation ("better off without me").
      // SW: "nataka kufa" (I want to die), "kujiua" (suicide), "kujidhuru"
      // (self-harm), "sitaki kuishi" (I don't want to live), "natamani nife".
      { pattern: /\bsuicide\b|\bkill\s+myself\b|\bwant\s+to\s+die\b|\bend\s+it\s+all\b|\bharm\s+myself\b|\bkujiua\b|\bnataka\s+kufa\b|\bkujidhuru\b|\bbetter\s+off\s+without\s+me\b|\bwish\s+i\s+(?:could\s+)?(?:just\s+)?(?:disappear|die|was\s+dead|wasn'?t\s+here)\b|\b(?:sleep|go\s+to\s+sleep)\s+and\s+(?:never|not)\s+wake\s+up\b|\bno\s+reason\s+to\s+live\b|\b(?:don'?t|do\s+not)\s+want\s+to\s+(?:be\s+alive|live|exist)\b|\bsitaki\s+kuishi\b|\bnatamani\s+(?:nife|kufa)\b|\bningependa\s+kufa\b|\bnijiue\b/i, sign: 'Suicidal ideation' },
      // SW: "kumdhuru mtoto" (harm the baby).
      { pattern: /\bhurt\s+the\s+baby\b|\bharm\s+the\s+baby\b|\bkill\s+the\s+baby\b|\bkumdhuru\s+mtoto\b|\bkumuua\s+mtoto\b/i, sign: 'Thoughts of harming baby' },

      // Newborn emergencies. SW: "mtoto hapumui" (baby isn't breathing).
      { pattern: /\bbaby\s+(?:is\s+)?(?:not|isn'?t)\s+breathing\b|\bbaby\b[^.]{0,20}\b(?:turning|turned|is|looks)\s+blue\b|\bmtoto\s+hapumui\b/i, sign: 'Newborn not breathing / blue' },
    ],
    response: `⚠️ URGENT: What you're describing could be very serious and needs IMMEDIATE medical attention.

Please do one of these RIGHT NOW:
1. Go to the nearest hospital/health center
2. Call an ambulance if available
3. Ask someone to take you

This cannot wait. Please go now and let me know once you're there. 💚`,
  },

  HIGH: {
    signs: [
      // Bleeding/spotting. SW: "damu" with bodily-context (kutoka/kutokwa/uchafuzi),
      // "kuvuja damu", "natoka damu", "nimeona damu", "damu kidogo".
      { pattern: /\bbleeding\b|\bspotting\b|\bblood\s+clots\b|\bgushing\s+blood\b|\bsoaking\s+(?:a\s+)?pad\b|\bkutokwa\s+na\s+damu\b|\bkuvuja\s+damu\b|\b(?:nina|na|me|ina)?(?:tokwa|vuja)\s+damu\b|\b(?:ni|na|nina|nili|ali|ana|ime|ina|me)?toka\s+damu\b|\b(?:saw|seen|see|noticed|found)\s+(?:a\s+)?(?:little\s+|some\s+|bit\s+of\s+)?blood\b|\bblood\s+(?:on|in)\s+(?:my\s+)?(?:underwear|pant\w*|pad|tissue|knickers)\b|\b\w*ona\s+damu\b|\bdamu\s+kidogo\b/i, sign: 'Vaginal bleeding' },
      // Severe headache. SW: "kichwa kinaniuma sana", "maumivu makali ya kichwa",
      // "kichwa yaniuma vibaya".
      { pattern: /\bsevere\s+headache\b|\bterrible\s+headache\b|\bworst\s+headache\b|\bkichwa\s+(?:kina|ya|kin)(?:ni)?(?:uma)\s+(?:sana|vibaya|mno)\b|\bmaumivu\s+(?:makali|mengi)\s+ya\s+kichwa\b/i, sign: 'Severe headache' },
      // Raised blood pressure: systolic 140–159 or diastolic 90–109.
      { pattern: /\b1[45]\d\s*(?:\/|over)\s*\d{2,3}\b|\b\d{2,3}\s*(?:\/|over)\s*(?:9\d|10\d)\b/i, sign: 'Raised blood pressure' },
      // Fever. SW: "homa" (fever), "joto kali" (high temperature/heat).
      { pattern: /\bfever\b|\bhigh\s+temperature\b|\bburning\s+up\b|\b3[89](?:\.\d+)?\s*°?\s*c\b|\b10[0-9](?:\.\d+)?\s*°?\s*f\b|\bhoma\b|\bjoto\s+kali\b/i, sign: 'Fever' },
      // Severe pain. SW: "maumivu makali" (severe pain).
      { pattern: /\bsevere\s+pain\b|\bterrible\s+pain\b|\bunbearable\s+pain\b|\bmaumivu\s+makali\b/i, sign: 'Severe pain' },
      // Regular contractions / labour pains. SW: "maumivu kila dakika 10".
      { pattern: /\b(?:pains?|contractions?|cramps?)\s+(?:coming\s+)?every\s+\d+\s*(?:-\s*\d+\s*)?(?:min|mins|minutes)\b|\bmaumivu\s+(?:\w+\s+){0,2}kila\s+dakika\b|\bmaumivu\s+(?:ya\s+)?uchungu\b/i, sign: 'Regular contractions' },
      // Persistent vomiting. SW: "kutapika sana", "kutapika kila saa",
      // "siwezi hata kunywa maji" (I can't even drink water).
      { pattern: /\bpersistent\s+vomiting\b|\bcan'?t\s+keep\b[^.]{0,20}\bdown\b|\bthrowing\s+up\s+constantly\b|\bvomiting\s+every\s+(?:hour|time)\b|\bkutapika\s+(?:sana|mfululizo|mara\s+nyingi)\b|\b(?:nina|me|na)tapika\s+(?:sana|mfululizo)\b|\b\w*tapika\s+kila\s+(?:saa|wakati|mara)\b|\b(?:siwezi|sijaweza)\s+(?:hata\s+)?kunywa\s+(?:hata\s+)?maji\b/i, sign: 'Persistent vomiting' },
      // Face swelling. SW grammar inserts possessive pronouns
      // (uso wangu / uso wake umevimba). The `\w+\s+` slot allows the
      // possessive without losing the noun-verb pairing.
      { pattern: /\b(?:swelling|swollen|puffy)\b[^.]{0,15}\bface\b|\bface\b[^.]{0,15}\b(?:swelling|swollen|puffy)\b|\buso\s+(?:\w+\s+)?ume(?:vimba|vimbiwa)\b|\buvimbe\s+(?:wa\s+)?uso\b/i, sign: 'Facial swelling' },
      // Hand swelling. SW: "mikono imevimba" / "mikono yangu imevimba".
      { pattern: /\b(?:swelling|swollen|puffy)\b[^.]{0,15}\bhands?\b|\bhands?\b[^.]{0,20}\b(?:swelling|swollen|puffy)\b|\bmikono\s+(?:\w+\s+)?ime(?:vimba|vimbiwa)\b|\buvimbe\s+(?:wa\s+)?mikono\b/i, sign: 'Hand swelling' },
      // Reduced fetal movement. EN forms naturally include "has/have/
      // hasn't/haven't been" between "baby" and "moving". SW: "mtoto
      // hatembei", "sijahisi mtoto", "mtoto hajatembea", "hasongi",
      // "anacheza/anasonga kidogo" (moving only a little).
      { pattern: /\bbaby\s+(?:has|have|hasn'?t|haven'?t|is|isn'?t)?(?:\s+been)?\s+not\s+(?:been\s+)?moving\b|\bbaby\s+(?:hasn'?t|haven'?t|isn'?t)\s+(?:been\s+)?moving\b|\bbaby\s+not\s+moving\b|\bno\s+(?:fetal\s+)?movement\b|\bhaven'?t\s+felt\b[^.]{0,30}\bbaby\b|\b(?:haven'?t|hasn'?t|isn'?t|not)\s+(?:been\s+)?(?:feeling|felt|feel)\s+(?:the\s+)?baby\s+(?:move|moving)\b|\bdecreased\s+movement\b|\bbaby\s+(?:moved|moving)\s+less\b|\bless\s+(?:fetal\s+)?movement\b|\bmoving\s+(?:much\s+|a\s+lot\s+|way\s+|really\s+)?less\b|\b(?:baby|she|he)\s+(?:has\s+not|hasn'?t|did\s+not|didn'?t|has\s+stopped|stopped)\s+(?:moved|moving|kicking|kicked)\b|\b(?:only\s+)?(?:a\s+)?few\s+kicks\b|\bfewer\s+kicks\b|\bnot\s+kicking\b|\bmtoto\s+ha(?:tembei|jatembea)\b|\bsijahisi\s+mtoto\b|\bmtoto\s+hatembei\s+sana\b|\bhasongi\b|\bhachezi\b|\bhaja(?:cheza|songa)\b|\bhapigi\s+teke\b|\b(?:ana)?(?:songa|cheza)\s+kidogo\b/i, sign: 'Reduced fetal movement' },
      { pattern: /\bsudden\s+weight\s+gain\b|\bgained\b[^.]{0,15}\b(?:pounds|kg|kilos)\b[^.]{0,15}\bweek\b/i, sign: 'Sudden weight gain' },
      // Violence or a fall in pregnancy. SW: "alinipiga/amenipiga" (he hit
      // me), "nimeanguka" (I fell).
      { pattern: /\b(?:husband|partner|boyfriend|he)\b[^.]{0,20}\b(?:hit|beat|kicked|punched|slapped|pushed)\s+me\b|\b(?:ali|ame|ana)nipiga\b|\b(?:nime|nili)anguka\b|\bi\s+fell\s+(?:down|over|on|off|hard)\b|\bfell\s+on\s+my\s+(?:belly|stomach|tummy)\b/i, sign: 'Violence or fall' },
      // Newborn danger signs (postpartum). SW: "mtoto hanyonyi" (not
      // feeding), "manjano" (jaundice), "kitovu ... usaha" (cord pus).
      { pattern: /\bbaby\b[^.]{0,30}\b(?:not\s+feeding|won'?t\s+(?:feed|breastfeed|latch|suck)|refus\w*\s+to\s+(?:feed|breastfeed)|very\s+yellow|yellow\s+(?:skin|eyes)|floppy|breathing\s+(?:very\s+)?fast)\b|\bmtoto\s+(?:hanyonyi|hataki\s+kunyonya|ana\s+manjano)\b|\bcord\b[^.]{0,20}\b(?:pus|smell\w*)\b|\bkitovu\b[^.]{0,20}\b(?:usaha|harufu)\b/i, sign: 'Newborn danger sign' },
    ],
    response: `⚠️ Important: This symptom needs to be checked by a healthcare provider TODAY.

Please visit your nearest clinic or hospital within the next few hours. Would you like help finding the closest facility?`,
  },

  MODERATE: {
    signs: [
      // Headache (mild). SW: "kichwa kinaniuma", "maumivu ya kichwa".
      { pattern: /\bheadache\b|\bhead\s+pain\b|\bkichwa\s+(?:kina|kin|ya)(?:ni)?uma\b|\bmaumivu\s+ya\s+kichwa\b/i, sign: 'Headache' },
      // Cramping. SW: "minyong'onyo", "tumbo kuuma kama hedhi".
      { pattern: /\bcramping\b|\bcramps\b|\bperiod-?like\s+pain\b|\bminyong'?onyo\b|\btumbo\s+kuuma\b/i, sign: 'Cramping' },
      // Back pain. SW: "maumivu ya mgongo", "mgongo unauma".
      { pattern: /\bback\s+pain\b|\bbackache\b|\blower\s+back\b|\bmaumivu\s+ya\s+mgongo\b|\bmgongo\s+(?:una|wa)?uma\b/i, sign: 'Back pain' },
      // Foot/ankle swelling. SW with optional possessive pronoun.
      { pattern: /\b(?:swelling|swollen|puffy)\b[^.]{0,15}\b(?:feet|ankles?)\b|\b(?:feet|ankles?)\b[^.]{0,15}\b(?:swelling|swollen|puffy)\b|\bmiguu\s+(?:\w+\s+)?(?:ime|zime)(?:vimba|vimbiwa)\b|\buvimbe\s+(?:wa\s+)?miguu\b/i, sign: 'Foot/ankle swelling' },
      { pattern: /\b(?:vaginal|unusual|thick|foul|smelly)\s+discharge\b|\bdischarge\b|\buchafuzi\b/i, sign: 'Vaginal discharge' },
      { pattern: /\b(?:gushing|losing|watery)\s+(?:fluid|fluids|leak\w*)\b|\b(?:fluid|fluids|leak\w*)\s+(?:from\s+(?:my\s+)?vagina|down\s+(?:my\s+)?legs)\b|\bleaking\s+(?:from\s+(?:my\s+)?vagina|down\s+(?:my\s+)?legs)\b|\bmaji\s+yana(?:tiririka|toka)\b/i, sign: 'Vaginal discharge / fluid' },
      // Dizziness. SW: "kizunguzungu" (dizziness/vertigo).
      { pattern: /\bdizzy\b|\bdizziness\b|\blightheaded\b|\bkizunguzungu\b/i, sign: 'Dizziness' },
      // Nausea. SW: "kichefuchefu" (nausea), "kutapika kidogo".
      { pattern: /\bnausea\b|\bmorning\s+sickness\b|\bfeeling\s+sick\b|\bkichefuchefu\b/i, sign: 'Nausea' },
      // Tired/exhausted/fatigued — only with allowed precedent and not followed by "of".
      // SW: "nimechoka" (I am tired), "nina uchovu" (I have fatigue).
      { pattern: new RegExp(`\\b${TIRED_PRECEDENT}\\s+${TIRED_INTENSIFIER}(?:tired|exhausted|fatigued)\\b(?!\\s+of\\b)|\\bnime(?:choka|chokesha)\\b|\\bnina\\s+uchovu\\b`, 'i'), sign: 'Fatigue' },
      { pattern: /\bno\s+energy\b|\bsina\s+nguvu\b/i, sign: 'Low energy' },
    ],
    response: `This is something to discuss with your healthcare provider soon. Can you schedule a visit this week?

In the meantime, rest and monitor how you feel. Let me know if symptoms worsen. 💚`,
  },
};

export function detectDangerSigns(message: string): DangerSignResult {
  const text = neutralizeForTriage(message);
  const detectedSigns: DetectedSign[] = [];
  let urgencyLevel: Urgency = 'low';
  let recommendedAction = '';

  for (const level of ['CRITICAL', 'HIGH', 'MODERATE'] as DangerLevelKey[]) {
    const category = DANGER_SIGNS[level];

    for (const signDef of category.signs) {
      if (signDef.pattern.test(text)) {
        detectedSigns.push({
          sign: signDef.sign,
          level: level.toLowerCase() as DetectedSign['level'],
        });

        if (level === 'CRITICAL' && urgencyLevel !== 'critical') {
          urgencyLevel = 'critical';
          recommendedAction = category.response;
        } else if (level === 'HIGH' && urgencyLevel !== 'critical') {
          urgencyLevel = 'high';
          recommendedAction = category.response;
        } else if (level === 'MODERATE' && urgencyLevel === 'low') {
          urgencyLevel = 'moderate';
          recommendedAction = category.response;
        }
      }
    }

    if (urgencyLevel === 'critical') break;
  }

  return {
    detectedSigns,
    urgencyLevel,
    requiresUrgentCare: urgencyLevel === 'critical' || urgencyLevel === 'high',
    recommendedAction,
  };
}

export function assessMood(message: string): Mood {
  const positiveIndicators = /\b(?:happy|excited|good|great|wonderful|blessed|grateful|thank|love|joy)\b/i;
  const negativeIndicators = /\b(?:sad|depressed|anxious|worried|scared|afraid|crying|hopeless|stressed|overwhelmed)\b/i;
  const neutralIndicators = /\b(?:okay|fine|alright|normal)\b/i;

  if (negativeIndicators.test(message)) {
    return 'negative';
  } else if (positiveIndicators.test(message)) {
    return 'positive';
  } else if (neutralIndicators.test(message)) {
    return 'neutral';
  }

  return 'neutral';
}

// Canonical symptom vocabulary extractSymptoms() below can return.
// Exported so a caller building a curated UI (e.g. the PWA's structured
// journal-form symptom chips, P2-C) can validate against exactly the
// same list instead of duplicating it out of sync. Keep in sync by hand
// with the `symptom:` values in the patterns array below.
export const SYMPTOM_VALUES: Symptom[] = [
  'nausea',
  'vomiting',
  'headache',
  'back_pain',
  'cramping',
  'bleeding',
  'swelling',
  'fatigue',
  'dizziness',
  'constipation',
  'heartburn',
  'insomnia',
];

export function extractSymptoms(message: string): Symptom[] {
  const symptoms: Symptom[] = [];
  const symptomPatterns: { pattern: RegExp; symptom: Symptom }[] = [
    { pattern: /\bnausea\b|\bmorning\s+sickness\b|\bfeeling\s+sick\b/i, symptom: 'nausea' },
    { pattern: /\bvomiting\b|\bthrowing\s+up\b/i, symptom: 'vomiting' },
    { pattern: /\bheadache\b|\bhead\s+pain\b/i, symptom: 'headache' },
    { pattern: /\bback\s+pain\b|\bbackache\b/i, symptom: 'back_pain' },
    { pattern: /\bcramping\b|\bcramps\b/i, symptom: 'cramping' },
    { pattern: /\bbleeding\b|\bspotting\b/i, symptom: 'bleeding' },
    { pattern: /\bswelling\b|\bswollen\b|\bedema\b/i, symptom: 'swelling' },
    { pattern: new RegExp(`\\b${TIRED_PRECEDENT}\\s+${TIRED_INTENSIFIER}(?:tired|exhausted|fatigued)\\b(?!\\s+of\\b)|\\bfatigue\\b`, 'i'), symptom: 'fatigue' },
    { pattern: /\bdizzy\b|\bdizziness\b|\blightheaded\b/i, symptom: 'dizziness' },
    { pattern: /\bconstipation\b|\bcan'?t\s+poop\b/i, symptom: 'constipation' },
    { pattern: /\bheartburn\b|\bacid\s+reflux\b/i, symptom: 'heartburn' },
    { pattern: /\binsomnia\b|\bcan'?t\s+sleep\b|\btrouble\s+sleeping\b/i, symptom: 'insomnia' },
  ];

  symptomPatterns.forEach(({ pattern, symptom }) => {
    if (pattern.test(message)) {
      symptoms.push(symptom);
    }
  });

  return symptoms;
}

// ---------------------------------------------------------------------------
// Once-per-episode escalation copy. The urgency, audit row and follow-up job
// are NEVER suppressed — only the wording shortens when the same (or a
// higher) level was already escalated recently, so a mother who keeps
// talking about the same bleed isn't sent the identical wall of text again.
// ---------------------------------------------------------------------------
export const ESCALATION_EPISODE_MS = 6 * 60 * 60 * 1000;

const URGENCY_RANK: Record<string, number> = { low: 0, moderate: 1, high: 2, critical: 3 };

export function escalationVariant(
  level: Urgency,
  recentTurns: { urgency_level?: string | null; timestamp?: string | null }[],
  now: Date,
  windowMs: number = ESCALATION_EPISODE_MS
): 'full' | 'repeat' {
  if (level !== 'critical' && level !== 'high') return 'full';
  const repeat = recentTurns.some((turn) => {
    const ts = parseSqliteUtc(turn.timestamp);
    if (ts == null || now.getTime() - ts > windowMs) return false;
    return (URGENCY_RANK[turn.urgency_level ?? 'low'] ?? 0) >= URGENCY_RANK[level];
  });
  return repeat ? 'repeat' : 'full';
}
