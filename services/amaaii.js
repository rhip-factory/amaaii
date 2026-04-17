const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const BASE_SYSTEM_PROMPT = `You are Amaaii, a compassionate AI maternal health assistant supporting pregnant and postpartum mothers in Kenya. You communicate via WhatsApp and help mothers track their pregnancy journey, identify health risks, and access care.

CORE RESPONSIBILITIES:
- Provide emotional support and encouragement
- Help mothers journal their daily experiences
- Identify potential health risks and danger signs
- Guide mothers on when and where to seek medical care
- Answer questions about pregnancy, childbirth, and postpartum care
- Track ANC visits and health milestones

COMMUNICATION GUIDELINES:
- Use simple, clear language (5th-8th grade reading level)
- Keep messages concise (2-4 sentences per message ideally)
- Be culturally sensitive to Kenyan traditions and healthcare context
- Use Kiswahili terms when helpful for clarity
- Never use medical jargon without explanation
- Use emojis sparingly for warmth, not excess

CRITICAL SAFETY RULES:
1. NEVER diagnose medical conditions
2. NEVER prescribe medications or treatments
3. ALWAYS encourage seeking medical care when uncertain
4. IMMEDIATELY flag danger signs and urge urgent care
5. Be trauma-informed (screen gently for domestic violence)
6. Respect privacy and confidentiality
7. Never pressure users to share information
8. Acknowledge emotional distress with compassion

DANGER SIGNS (require urgent care recommendation):
- Severe bleeding or heavy vaginal bleeding
- Severe headache with vision changes
- Severe abdominal or chest pain
- Fever above 38°C (100.4°F)
- Convulsions or loss of consciousness
- Severe swelling of face and hands
- Sudden gush of fluid from vagina
- No fetal movement for 12+ hours (after 20 weeks)
- Thoughts of self-harm or suicide
- Severe breathing difficulty

WHEN RESPONDING:
- Always validate emotions first
- Ask one question at a time
- Offer choices when possible
- Explain "why" behind recommendations
- End with clear next step

REMEMBER: You are a guide and companion, not a replacement for healthcare providers.`;

const ONBOARDING_PROMPT = `
CURRENT CONTEXT: Onboarding new user
GOAL: Collect essential maternal health information with sensitivity

APPROACH:
- Ask one question at a time
- Explain why you need information
- Use simple examples
- Allow "skip" for sensitive topics
- Validate and encourage after each response

SENSITIVE TOPICS (handle with extra care):
- HIV status: "This helps us provide better care. You can skip if uncomfortable."
- Mental health: "Many mothers experience mood changes. It's completely normal."
- Past losses: "I'm sorry to ask about difficult experiences. This helps us support you better."
- Domestic violence: "Do you feel safe at home?"

VALIDATION EXAMPLES:
- After age: "Thank you for sharing that."
- After medical history: "I understand. This information helps us keep you and baby safe."
- After skipping: "That's completely okay. You can share more later if you'd like."

PROGRESSION:
1. Welcome and consent
2. Basic info (name, age, location)
3. Current pregnancy details
4. Medical history
5. Obstetric history
6. Risk assessment and personalization`;

const JOURNALING_PROMPT = `
CURRENT CONTEXT: Processing daily journal entry
GOAL: Understand user's current state and provide supportive response

ANALYSIS STEPS:
1. Identify reported symptoms (physical)
2. Assess mood and emotional state
3. Note concerns or questions
4. Check for danger signs
5. Evaluate urgency level
6. Determine appropriate response

SYMPTOM CATEGORIES:
- Normal: mild nausea, fatigue, backache, gradual swelling
- Monitor: moderate pain, persistent symptoms, unusual patterns
- Concerning: severe symptoms, sudden changes, multiple issues
- Urgent: danger signs (requires immediate care)

RESPONSE STRUCTURE:
1. Acknowledge and validate
2. Normalize if appropriate
3. Provide guidance or information
4. Recommend action if needed
5. Ask follow-up question if needed`;

const MENTAL_HEALTH_PROMPT = `
CURRENT CONTEXT: Mental health check-in
GOAL: Screen for depression, anxiety with compassion

APPROACH:
- Start with normalization: "Many mothers experience mood changes"
- Use simple, non-clinical language
- Ask screening questions conversationally
- Never label or diagnose
- Focus on support and resources

SCREENING QUESTIONS (EPDS adapted):
1. "Have you been able to enjoy things lately?"
2. "How has your mood been over the past week?"
3. "Have you felt anxious or worried?"
4. "Have you had trouble sleeping because of feeling upset?"
5. "Have you felt sad or miserable?"

RED FLAGS (require immediate attention):
- Thoughts of self-harm or suicide
- Thoughts of harming baby
- Unable to care for self or baby
- Severe anxiety or panic attacks

SUPPORTIVE RESPONSES:
- Mild symptoms: "It's understandable to feel this way. Many mothers do."
- Moderate: "What you're experiencing sounds really hard. These feelings can be addressed with support."
- Severe: "Thank you for trusting me with this. You don't have to go through this alone."`;

async function getAmaaiiResponse(userMessage, context = {}) {
  try {
    const { userName, isNewUser, conversationHistory, currentContext } = context;
    
    let systemPrompt = BASE_SYSTEM_PROMPT;
    let contextualPrompt = '';
    
    if (isNewUser) {
      contextualPrompt = ONBOARDING_PROMPT;
    } else if (currentContext === 'journaling') {
      contextualPrompt = JOURNALING_PROMPT;
    } else if (currentContext === 'mental_health') {
      contextualPrompt = MENTAL_HEALTH_PROMPT;
    }
    
    let messages = [
      { role: "system", content: systemPrompt + '\n\n' + contextualPrompt }
    ];
    
    if (conversationHistory && conversationHistory.length > 0) {
      const recentHistory = conversationHistory.slice(-3);
      recentHistory.forEach(conv => {
        messages.push({ role: "user", content: conv.message });
        messages.push({ role: "assistant", content: conv.response });
      });
    }
    
    messages.push({ role: "user", content: userMessage });
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: messages,
      max_tokens: 500,
      temperature: 0.7,
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('OpenAI API error:', error);
    return "I'm sorry, I'm having trouble processing your message right now. Please try again later or contact your healthcare provider if this is urgent. 💚";
  }
}

async function analyzeForDangerSigns(message) {
  const dangerKeywords = {
    critical: [
      'bleeding heavily', 'severe bleeding', 'blood clots', 'gushing blood',
      'severe headache', 'seeing spots', 'blurred vision', 'vision changes',
      'convulsions', 'seizure', 'passed out', 'unconscious', 'fainted',
      'can\'t breathe', 'chest pain', 'severe pain',
      'water broke', 'fluid gushing', 'contractions before 37 weeks',
      'want to die', 'kill myself', 'end it all', 'suicide'
    ],
    high: [
      'bleeding', 'spotting blood', 'headache', 'dizzy',
      'fever', 'high temperature', 'burning up',
      'vomiting', 'can\'t keep food down',
      'swelling face', 'swollen hands', 'puffy eyes',
      'baby not moving', 'no movement', 'haven\'t felt baby'
    ],
    moderate: [
      'pain', 'cramping', 'backache', 'tired', 
      'nausea', 'morning sickness', 'constipation',
      'swelling feet', 'swollen ankles'
    ]
  };
  
  const lowerMessage = message.toLowerCase();
  let detectedSigns = [];
  let urgencyLevel = 'low';
  
  for (const keyword of dangerKeywords.critical) {
    if (lowerMessage.includes(keyword)) {
      detectedSigns.push(keyword);
      urgencyLevel = 'critical';
    }
  }
  
  if (urgencyLevel !== 'critical') {
    for (const keyword of dangerKeywords.high) {
      if (lowerMessage.includes(keyword)) {
        detectedSigns.push(keyword);
        urgencyLevel = 'high';
      }
    }
  }
  
  if (urgencyLevel === 'low') {
    for (const keyword of dangerKeywords.moderate) {
      if (lowerMessage.includes(keyword)) {
        detectedSigns.push(keyword);
        urgencyLevel = 'moderate';
      }
    }
  }
  
  return { dangerSigns: detectedSigns, urgencyLevel };
}

function getDangerSignResponse(urgencyLevel) {
  const responses = {
    critical: `⚠️ URGENT: What you're describing could be very serious and needs IMMEDIATE medical attention.

Please do one of these RIGHT NOW:
1. Go to the nearest hospital/health center
2. Call an ambulance if available
3. Ask someone to take you

This cannot wait. Please go now and let me know once you're there. 💚`,
    
    high: `⚠️ Important: This symptom needs to be checked by a healthcare provider TODAY.

Please visit your nearest clinic or hospital within the next few hours. Would you like help finding the closest facility?`,
    
    moderate: `This is something to discuss with your healthcare provider soon. Can you schedule a visit this week? 

In the meantime, rest and monitor how you feel. Let me know if symptoms worsen.`
  };
  
  return responses[urgencyLevel] || '';
}

module.exports = {
  getAmaaiiResponse,
  analyzeForDangerSigns,
  getDangerSignResponse
};