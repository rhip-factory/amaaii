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

const TIRED_PRECEDENT = '(?:i\'?m|i\\s+am|am|i\\s+feel|feel|feeling|so|very|extremely)';
const TIRED_INTENSIFIER = '(?:so\\s+|very\\s+|extremely\\s+|really\\s+)?';

const DANGER_SIGNS = {
  CRITICAL: {
    signs: [
      // Bleeding (severe). Word-bounded "bleeding" + heavy/heavily/severe in either order.
      { pattern: /\bsevere\s+bleeding\b|\bheavy\s+bleeding\b|\bbleeding\s+(?:heavily|severely|a\s+lot|profusely)\b|\bblood\s+clots\b|\bgushing\s+blood\b|\bsoaking\s+(?:a\s+)?pad\b/i, sign: 'Severe vaginal bleeding' },

      // Severe headache with vision changes, or visual disturbance alone.
      { pattern: /\bsevere\s+headache\b[^.]{0,40}\b(?:vision|seeing\s+spots|blurred)\b|\bvision\b[^.]{0,40}\bsevere\s+headache\b|\bseeing\s+spots\b|\bblurred\s+vision\b/i, sign: 'Severe headache with vision changes' },

      { pattern: /\bconvulsions?\b|\bseizures?\b|\bjerking\b/i, sign: 'Convulsions or seizures' },
      { pattern: /\bpassed\s+out\b|\bunconscious\b|\bfainted\b|\bcollapsed\b/i, sign: 'Loss of consciousness' },
      { pattern: /\bcan'?t\s+breathe\b|\bdifficulty\s+breathing\b|\bgasping\b|\bchoking\b/i, sign: 'Severe breathing difficulty' },
      { pattern: /\bsevere\s+chest\s+pain\b|\bcrushing\s+chest\b|\bheart\s+attack\b/i, sign: 'Severe chest pain' },

      // Rupture of membranes — water-broke phrases or amniotic fluid gush.
      { pattern: /\bwater\s+broke\b|\bwater\s+breaking\b|\bamniotic\s+fluid\b|\bfluid\s+gushing\b|\bgushing\s+fluid\b|\bfluid\s+down\s+(?:my\s+)?legs\b/i, sign: 'Rupture of membranes' },

      { pattern: /\bsuicide\b|\bkill\s+myself\b|\bwant\s+to\s+die\b|\bend\s+it\s+all\b|\bharm\s+myself\b/i, sign: 'Suicidal ideation' },
      { pattern: /\bhurt\s+the\s+baby\b|\bharm\s+the\s+baby\b|\bkill\s+the\s+baby\b/i, sign: 'Thoughts of harming baby' },
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
      // Bleeding/spotting (without "blood" alone). Specific clot/pad cues
      // are also kept here so bleeding-related HIGH still matches when
      // CRITICAL doesn't fire.
      { pattern: /\bbleeding\b|\bspotting\b|\bblood\s+clots\b|\bgushing\s+blood\b|\bsoaking\s+(?:a\s+)?pad\b/i, sign: 'Vaginal bleeding' },
      { pattern: /\bsevere\s+headache\b|\bterrible\s+headache\b|\bworst\s+headache\b/i, sign: 'Severe headache' },
      { pattern: /\bfever\b|\bhigh\s+temperature\b|\bburning\s+up\b|\b3[89](?:\.\d+)?\s*°?\s*c\b|\b10[0-9](?:\.\d+)?\s*°?\s*f\b/i, sign: 'Fever' },
      { pattern: /\bsevere\s+pain\b|\bterrible\s+pain\b|\bunbearable\s+pain\b/i, sign: 'Severe pain' },
      { pattern: /\bpersistent\s+vomiting\b|\bcan'?t\s+keep\b[^.]{0,20}\bdown\b|\bthrowing\s+up\s+constantly\b/i, sign: 'Persistent vomiting' },
      // Face swelling — bidirectional ("face swollen" or "swollen face").
      { pattern: /\b(?:swelling|swollen|puffy)\b[^.]{0,15}\bface\b|\bface\b[^.]{0,15}\b(?:swelling|swollen|puffy)\b/i, sign: 'Facial swelling' },
      // Hand swelling — bidirectional.
      { pattern: /\b(?:swelling|swollen|puffy)\b[^.]{0,15}\bhands?\b|\bhands?\b[^.]{0,20}\b(?:swelling|swollen|puffy)\b/i, sign: 'Hand swelling' },
      // Reduced fetal movement.
      { pattern: /\bbaby\s+not\s+moving\b|\bno\s+(?:fetal\s+)?movement\b|\bhaven'?t\s+felt\b[^.]{0,30}\bbaby\b|\bdecreased\s+movement\b|\bbaby\s+(?:moved|moving)\s+less\b|\bless\s+(?:fetal\s+)?movement\b/i, sign: 'Reduced fetal movement' },
      { pattern: /\bsudden\s+weight\s+gain\b|\bgained\b[^.]{0,15}\b(?:pounds|kg|kilos)\b[^.]{0,15}\bweek\b/i, sign: 'Sudden weight gain' },
    ],
    response: `⚠️ Important: This symptom needs to be checked by a healthcare provider TODAY.

Please visit your nearest clinic or hospital within the next few hours. Would you like help finding the closest facility?`,
  },

  MODERATE: {
    signs: [
      { pattern: /\bheadache\b|\bhead\s+pain\b/i, sign: 'Headache' },
      { pattern: /\bcramping\b|\bcramps\b|\bperiod-?like\s+pain\b/i, sign: 'Cramping' },
      { pattern: /\bback\s+pain\b|\bbackache\b|\blower\s+back\b/i, sign: 'Back pain' },
      // Foot/ankle swelling — bidirectional.
      { pattern: /\b(?:swelling|swollen|puffy)\b[^.]{0,15}\b(?:feet|ankles?)\b|\b(?:feet|ankles?)\b[^.]{0,15}\b(?:swelling|swollen|puffy)\b/i, sign: 'Foot/ankle swelling' },
      // Discharge: qualified phrase OR bare word (\b excludes "discharged").
      { pattern: /\b(?:vaginal|unusual|thick|foul|smelly)\s+discharge\b|\bdischarge\b/i, sign: 'Vaginal discharge' },
      // Fluid/leaking — clinical prefix or bodily-context suffix.
      { pattern: /\b(?:gushing|losing|watery)\s+(?:fluid|fluids|leak\w*)\b|\b(?:fluid|fluids|leak\w*)\s+(?:from\s+(?:my\s+)?vagina|down\s+(?:my\s+)?legs)\b|\bleaking\s+(?:from\s+(?:my\s+)?vagina|down\s+(?:my\s+)?legs)\b/i, sign: 'Vaginal discharge / fluid' },
      { pattern: /\bdizzy\b|\bdizziness\b|\blightheaded\b/i, sign: 'Dizziness' },
      { pattern: /\bnausea\b|\bmorning\s+sickness\b|\bfeeling\s+sick\b/i, sign: 'Nausea' },
      // Tired/exhausted/fatigued — only with allowed precedent and not followed by "of".
      { pattern: new RegExp(`\\b${TIRED_PRECEDENT}\\s+${TIRED_INTENSIFIER}(?:tired|exhausted|fatigued)\\b(?!\\s+of\\b)`, 'i'), sign: 'Fatigue' },
      { pattern: /\bno\s+energy\b/i, sign: 'Low energy' },
    ],
    response: `This is something to discuss with your healthcare provider soon. Can you schedule a visit this week?

In the meantime, rest and monitor how you feel. Let me know if symptoms worsen. 💚`,
  },
};

function detectDangerSigns(message) {
  const detectedSigns = [];
  let urgencyLevel = 'low';
  let recommendedAction = '';

  for (const level of ['CRITICAL', 'HIGH', 'MODERATE']) {
    const category = DANGER_SIGNS[level];

    for (const signDef of category.signs) {
      if (signDef.pattern.test(message)) {
        detectedSigns.push({
          sign: signDef.sign,
          level: level.toLowerCase(),
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

function assessMood(message) {
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

function extractSymptoms(message) {
  const symptoms = [];
  const symptomPatterns = [
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

module.exports = {
  detectDangerSigns,
  assessMood,
  extractSymptoms,
  DANGER_SIGNS,
};
