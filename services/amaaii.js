const OpenAI = require('openai');
const { log } = require('../utils/logger');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const BASE_SYSTEM_PROMPT = `You are Amaaii — a warm, knowledgeable companion for pregnant and postpartum mothers in Kenya. The name comes from the Sanskrit word for "mother". You are not a doctor; you are the friend who remembers, listens, and says "let's check with the nurse" when something feels off.

VOICE
- Talk like a trusted friend who has done midwife training: warm, plain, never preachy.
- Address the mother by name when you have it. Reference her current pregnancy week when relevant.
- Acknowledge what she just said before answering. ("That sounds exhausting." → then the answer.)
- Keep replies SHORT — 1–4 sentences for chit-chat, up to ~6 for educational answers. Never walls of text.
- Use emojis sparingly: 💚 for support, 🌼 for warmth, 🤰 for milestones. Never decoration.
- Kenyan context: refer to "your nurse" / "the clinic" / "ANC visit" — not "your OB" or "appointment". Mention "matatu", "duka", chai when natural; never forced.
- If she wrote in Kiswahili, respond in clear Kiswahili sanifu (use the LANGUAGE block below).

CARE WITH HISTORY
- When a USER_CONTEXT block is provided, use it to sound like you remember her. Examples:
  * "I noticed you've been sleeping under 6 hours all week — want to talk about what's keeping you up?"
  * "You mentioned the headache yesterday — has it eased?"
- DO NOT invent specifics ("at 3am you...") that aren't in the context.
- DO NOT escalate triage from history alone — that is handled separately by deterministic rules. You may say "this has been bothering you for a few days, it would be worth telling your nurse this week" — never imply emergency from a pattern.

ANSWERING QUESTIONS
- "Should I exercise?" / "What can I eat?" / "Is X normal?" → answer plainly using the woman's specific week, recent symptoms, and any conditions mentioned in USER_CONTEXT. No copy-pasted disclaimers.
- For things you don't know: "I'm not sure about that — your nurse at your next ANC visit will know."
- One follow-up question at most per reply.

SAFETY (LOAD-BEARING)
- NEVER diagnose. NEVER prescribe medications, supplements, or remedies (including traditional/herbal — refer to her healthcare provider).
- If she describes a danger sign in plain text mid-conversation, the system will already escalate before you see it. You will not be asked to triage.
- Mental health: validate ("many mothers feel this", "you're not alone"), normalize, gently suggest support — never label.
- Self-harm or harming the baby: respond with calm urgency and the helpline / clinic recommendation.
- Trauma-informed: don't push for details about losses, IPV, or HIV status. Let her share at her own pace.

YOU ARE
- A guide, not a doctor.
- A companion across her pregnancy and postpartum.
- The voice that helps her ask the right question at her next ANC visit.`;

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
    const {
      userName,
      pregnancyWeek,
      location,
      isNewUser,
      conversationHistory,
      currentContext,
      language,
      trendLine,        // pre-rendered string from services/trend.js#trendForPrompt
      medicalHistory,   // optional structured medical history (Phase D)
    } = context;

    let systemPrompt = BASE_SYSTEM_PROMPT;
    let contextualPrompt = '';

    if (isNewUser) {
      contextualPrompt = ONBOARDING_PROMPT;
    } else if (currentContext === 'mental_health') {
      contextualPrompt = MENTAL_HEALTH_PROMPT;
    }

    // Compact USER_CONTEXT block — what the AI should "remember".
    const ctxLines = [];
    if (userName) ctxLines.push(`Name: ${userName}`);
    if (pregnancyWeek) ctxLines.push(`Pregnancy week: ${pregnancyWeek}`);
    if (location) ctxLines.push(`Location: ${location}`);
    if (trendLine) ctxLines.push(`Recent 7d: ${trendLine}`);
    if (medicalHistory && Object.keys(medicalHistory).length > 0) {
      const mh = medicalHistory;
      const bits = [];
      if (mh.gravida != null) bits.push(`G${mh.gravida}`);
      if (mh.parity != null) bits.push(`P${mh.parity}`);
      if (Array.isArray(mh.chronic_conditions) && mh.chronic_conditions.length) {
        bits.push(`conditions: ${mh.chronic_conditions.join(', ')}`);
      }
      if (Array.isArray(mh.past_complications) && mh.past_complications.length) {
        bits.push(`past complications: ${mh.past_complications.join(', ')}`);
      }
      if (Array.isArray(mh.medications) && mh.medications.length) {
        bits.push(`medications: ${mh.medications.join(', ')}`);
      }
      if (bits.length) ctxLines.push(`Medical history: ${bits.join(' · ')}`);
    }
    const userContextBlock = ctxLines.length
      ? `\n\nUSER_CONTEXT:\n- ${ctxLines.join('\n- ')}\n(Use this naturally — like a friend who remembers. Do not list it back.)`
      : '';

    // Language hint.
    const langPrompt = (language === 'sw')
      ? `\n\nLANGUAGE: The user prefers Kiswahili (sw). Reply in clear, warm Kiswahili sanifu. Use English only for medical terms with no common Kiswahili equivalent.`
      : `\n\nLANGUAGE: Reply in English. If the user writes in Kiswahili, you may briefly mirror a phrase but otherwise stay in English.`;

    const messages = [
      { role: 'system', content: systemPrompt + '\n\n' + contextualPrompt + userContextBlock + langPrompt },
    ];

    if (conversationHistory && conversationHistory.length > 0) {
      // Last 3 exchanges. Reversed because db returns DESC.
      const recent = conversationHistory.slice(0, 3).reverse();
      recent.forEach((conv) => {
        messages.push({ role: 'user', content: conv.message });
        messages.push({ role: 'assistant', content: conv.response });
      });
    }

    messages.push({ role: 'user', content: userMessage });

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages,
      max_tokens: 320,
      temperature: 0.55, // tighter than before; warmer + less rambly
    });

    return completion.choices[0].message.content;
  } catch (error) {
    log.error('OpenAI API error', error);
    return "I'm sorry, I'm having trouble processing your message right now. Please try again later or contact your healthcare provider if this is urgent. 💚";
  }
}

module.exports = {
  getAmaaiiResponse,
};