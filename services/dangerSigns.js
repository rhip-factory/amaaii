const DANGER_SIGNS = {
  CRITICAL: {
    signs: [
      { pattern: /severe bleeding|heavy bleeding|blood clots|gushing blood|soaking pad/i, sign: 'Severe vaginal bleeding' },
      { pattern: /severe headache.*vision|vision.*severe headache|seeing spots|blurred vision/i, sign: 'Severe headache with vision changes' },
      { pattern: /convulsion|seizure|fits|jerking/i, sign: 'Convulsions or seizures' },
      { pattern: /passed out|unconscious|fainted|collapsed/i, sign: 'Loss of consciousness' },
      { pattern: /can't breathe|difficulty breathing|gasping|choking/i, sign: 'Severe breathing difficulty' },
      { pattern: /severe chest pain|heart attack|crushing chest/i, sign: 'Severe chest pain' },
      { pattern: /water broke|fluid gushing|water breaking|amniotic fluid/i, sign: 'Rupture of membranes' },
      { pattern: /suicide|kill myself|want to die|end it all|harm myself/i, sign: 'Suicidal ideation' },
      { pattern: /hurt the baby|harm the baby|kill the baby/i, sign: 'Thoughts of harming baby' }
    ],
    response: `⚠️ URGENT: What you're describing could be very serious and needs IMMEDIATE medical attention.

Please do one of these RIGHT NOW:
1. Go to the nearest hospital/health center
2. Call an ambulance if available  
3. Ask someone to take you

This cannot wait. Please go now and let me know once you're there. 💚`
  },
  
  HIGH: {
    signs: [
      { pattern: /bleeding|spotting|blood/i, sign: 'Vaginal bleeding' },
      { pattern: /severe headache|terrible headache|worst headache/i, sign: 'Severe headache' },
      { pattern: /fever|high temperature|burning up|38\s*c|100\s*f/i, sign: 'Fever' },
      { pattern: /severe pain|terrible pain|unbearable pain/i, sign: 'Severe pain' },
      { pattern: /persistent vomiting|can't keep.*down|throwing up constantly/i, sign: 'Persistent vomiting' },
      { pattern: /swelling.*face|swollen face|puffy face/i, sign: 'Facial swelling' },
      { pattern: /swelling.*hands|swollen hands|puffy hands/i, sign: 'Hand swelling' },
      { pattern: /baby not moving|no movement|haven't felt.*baby|decreased movement/i, sign: 'Reduced fetal movement' },
      { pattern: /sudden weight gain|gained.*pounds.*week/i, sign: 'Sudden weight gain' }
    ],
    response: `⚠️ Important: This symptom needs to be checked by a healthcare provider TODAY.

Please visit your nearest clinic or hospital within the next few hours. Would you like help finding the closest facility?`
  },
  
  MODERATE: {
    signs: [
      { pattern: /headache|head pain/i, sign: 'Headache' },
      { pattern: /cramping|cramps|period-like pain/i, sign: 'Cramping' },
      { pattern: /back pain|backache|lower back/i, sign: 'Back pain' },
      { pattern: /swelling.*feet|swollen feet|swelling.*ankles/i, sign: 'Foot/ankle swelling' },
      { pattern: /discharge|leaking|fluid/i, sign: 'Vaginal discharge' },
      { pattern: /dizziness|dizzy|lightheaded/i, sign: 'Dizziness' },
      { pattern: /nausea|morning sickness|feeling sick/i, sign: 'Nausea' },
      { pattern: /tired|exhausted|fatigue|no energy/i, sign: 'Fatigue' }
    ],
    response: `This is something to discuss with your healthcare provider soon. Can you schedule a visit this week?

In the meantime, rest and monitor how you feel. Let me know if symptoms worsen. 💚`
  }
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
          level: level.toLowerCase()
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
    recommendedAction
  };
}

function assessMood(message) {
  const positiveIndicators = /happy|excited|good|great|wonderful|blessed|grateful|thank|love|joy/i;
  const negativeIndicators = /sad|depressed|anxious|worried|scared|afraid|crying|hopeless|stressed|overwhelmed/i;
  const neutralIndicators = /okay|fine|alright|normal/i;
  
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
    { pattern: /nausea|morning sickness|feeling sick/i, symptom: 'nausea' },
    { pattern: /vomiting|throwing up/i, symptom: 'vomiting' },
    { pattern: /headache|head pain/i, symptom: 'headache' },
    { pattern: /back pain|backache/i, symptom: 'back_pain' },
    { pattern: /cramping|cramps/i, symptom: 'cramping' },
    { pattern: /bleeding|spotting/i, symptom: 'bleeding' },
    { pattern: /swelling|swollen|edema/i, symptom: 'swelling' },
    { pattern: /tired|fatigue|exhausted/i, symptom: 'fatigue' },
    { pattern: /dizzy|dizziness|lightheaded/i, symptom: 'dizziness' },
    { pattern: /constipation|can't poop/i, symptom: 'constipation' },
    { pattern: /heartburn|acid reflux/i, symptom: 'heartburn' },
    { pattern: /insomnia|can't sleep|trouble sleeping/i, symptom: 'insomnia' }
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
  DANGER_SIGNS
};