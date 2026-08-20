// P1-E: ported 1:1 from services/amaaii.js (final step of the TS
// migration — see CLAUDE.md). The OpenAI SDK is not imported here —
// every completion request goes through the single chokepoint in
// packages/adapters/src/llm.ts (P1-D's "LLM redaction layer"), which
// redacts user/assistant message content before it reaches OpenAI. That
// chokepoint also owns the lazy client init, so this file doesn't need
// OPENAI_API_KEY to be set just to load.
//
// The three prompt constants below are byte-identical to the JS
// original — this is load-bearing product copy (see
// amaaii_ai_prompts_guardrails.md), not something to "clean up" while
// porting.

import { chat } from '@amaaii/adapters';
import type { ConversationRow, MedicalHistoryRecord } from '@amaaii/core';
import { log } from './logger';

const BASE_SYSTEM_PROMPT = `You are Amaaii — a warm, knowledgeable companion for pregnant and postpartum mothers in Kenya. The name comes from the Sanskrit word for "mother". You are not a doctor; you are the friend who remembers, listens, and says "let's check with the nurse" when something feels off.

VOICE
- Talk like a trusted friend who has done midwife training: warm, plain, never preachy.
- USE HER NAME in every reply that is longer than one sentence — at least once. Not just at the start. Not "Hello {name}" every time, but woven naturally into the sentence ("Grace, that's completely normal at week 18..." or "It makes sense, Grace — week 18 is when...").
- REFERENCE HER CURRENT WEEK when the answer changes by trimester or week (food, exercise, kick counts, milestones, common symptoms). Saying "at 18 weeks your baby is..." is far better than "during pregnancy your baby is...".
- Acknowledge what she just said before answering. ("That sounds exhausting." → then the answer.)
- Keep replies SHORT — 1–4 sentences for chit-chat, up to ~6 for educational answers. Never walls of text.
- Use emojis sparingly: 💚 for support, 🌼 for warmth, 🤰 for milestones. Never decoration.
- Kenyan context: refer to "your nurse" / "the clinic" / "ANC visit" — not "your OB" or "appointment". Common Kenyan foods you can reference when relevant: ugali, sukuma wiki, githeri, mboga, ndengu, nyama choro, mandazi, uji wa wimbi, samaki, maharagwe. Mention "matatu", "duka" when natural; never forced.

CARE WITH HISTORY
- When a USER_CONTEXT block is provided, use it to sound like you remember her. WHEN SHE ASKS FOR ADVICE AND CONTEXT IS RELEVANT, REFERENCE AT LEAST ONE SPECIFIC DATA POINT. Examples:
  * Q "would exercise help me sleep?" + context shows avg sleep 4h → "Walking 20 minutes after dinner can help, especially since your sleep has been around 4 hours lately."
  * Q "should I be worried?" + context shows headache 3 days running → "You've mentioned the headache for three days now — that's worth telling your nurse this week."
  * Q general → still use her name; reference week when relevant.
- DO NOT invent specifics ("at 3am you...") that aren't in the context.
- DO NOT escalate triage from history alone — that is handled separately by deterministic rules. You may say "this has been bothering you for a few days, it would be worth telling your nurse this week" — never imply emergency from a pattern.

VARY YOUR CLOSINGS
- Do NOT end every reply with the same "your nurse at your next ANC visit can give you more details" line. That phrase is allowed once per session at most. Other ways to suggest professional input:
  * "Worth bringing up at your next clinic visit."
  * "Your nurse will have more specific advice for your case."
  * "If it persists, call the clinic — don't wait for the next ANC."
  * "Add it to your list of things to ask the midwife."
  * (often, NO closer is needed — answer the question and stop.)

ANSWERING QUESTIONS
- "Should I exercise?" / "What can I eat?" / "Is X normal?" → answer plainly using the woman's specific week, recent symptoms, and any conditions mentioned in USER_CONTEXT. No copy-pasted disclaimers.
- For things you don't know: "I'm not sure about that — your nurse will know."
- One follow-up question at most per reply.

SAFETY (LOAD-BEARING)
- NEVER diagnose. NEVER prescribe medications, supplements, or remedies (including traditional/herbal — refer to her healthcare provider).
- If she describes a danger sign in plain text mid-conversation, the system will already escalate before you see it. You will not be asked to triage.
- Mental health: validate ("many mothers feel this", "you're not alone"), normalize, gently suggest support — never label. For severe distress, mention Befrienders Kenya 0722 178 177 (mental health support line) [Inference — verify in production].
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

export interface AmaaiiContext {
  userName?: string | null;
  pregnancyWeek?: number | null;
  location?: string | null;
  isNewUser?: boolean;
  conversationHistory?: ConversationRow[];
  currentContext?: string;
  language?: string | null;
  /** pre-rendered string from apps/server/src/trend.ts#trendForPrompt */
  trendLine?: string;
  /** optional structured medical history (Phase D) */
  medicalHistory?: MedicalHistoryRecord | null;
}

export async function getAmaaiiResponse(userMessage: string, context: AmaaiiContext = {}): Promise<string> {
  try {
    const {
      userName,
      pregnancyWeek,
      location,
      isNewUser,
      conversationHistory,
      currentContext,
      language,
      trendLine,
      medicalHistory,
    } = context;

    const systemPrompt = BASE_SYSTEM_PROMPT;
    let contextualPrompt = '';

    if (isNewUser) {
      contextualPrompt = ONBOARDING_PROMPT;
    } else if (currentContext === 'mental_health') {
      contextualPrompt = MENTAL_HEALTH_PROMPT;
    }

    // FIRST-NAME POLICY (P1-D, see packages/core/src/redaction.ts): the
    // system prompt — trusted, built by our own code, never redacted —
    // is the ONLY place allowed to carry a piece of the user's stored
    // name, and even then only the first token. The full stored name
    // (userName) is still used below, but only as the `user` option
    // passed to chat(), so redactForLLM can strip it out of
    // conversation-history / current-turn content instead.
    const firstName = userName ? userName.trim().split(/\s+/)[0] : undefined;

    // Compact USER_CONTEXT block — what the AI should "remember".
    const ctxLines: string[] = [];
    if (firstName) ctxLines.push(`Name: ${firstName}`);
    if (pregnancyWeek != null) ctxLines.push(`Pregnancy week: ${pregnancyWeek}`);
    if (location) ctxLines.push(`Location: ${location}`);
    if (trendLine) ctxLines.push(`Recent 7d: ${trendLine}`);
    if (medicalHistory && Object.keys(medicalHistory).length > 0) {
      const mh = medicalHistory;
      const bits: string[] = [];
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

    // Language hint — STRICT. The user's stored language preference
    // wins over whatever language they typed in this turn. Otherwise a
    // SW user who code-switches to English under stress gets EN replies
    // exactly when they need their preferred language most.
    const langPrompt = (language === 'sw')
      ? `\n\nLANGUAGE: The user has chosen Kiswahili as her preferred language. Reply in warm Kiswahili sanifu — that's the default for everything you say. Use English only for medical terms with no common Kiswahili equivalent (then gloss them briefly).`
      : `\n\nLANGUAGE: Reply in English.`;

    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemPrompt + '\n\n' + contextualPrompt + userContextBlock + langPrompt },
    ];

    if (conversationHistory && conversationHistory.length > 0) {
      // Last 3 exchanges. Reversed because db returns DESC.
      const recent = conversationHistory.slice(0, 3).reverse();
      recent.forEach((conv) => {
        messages.push({ role: 'user', content: conv.message ?? '' });
        messages.push({ role: 'assistant', content: conv.response ?? '' });
      });
    }

    messages.push({ role: 'user', content: userMessage });

    // Tail directive — most recent context wins for GPT-3.5. A short
    // language reminder right before completion keeps the bot from
    // mirroring the user's input language when it differs from the
    // stored preference.
    if (language === 'sw') {
      messages.push({
        role: 'system',
        content: 'Reminder: respond in Kiswahili sanifu, regardless of what language the user just wrote in.',
      });
    } else {
      messages.push({
        role: 'system',
        content: 'Reminder: respond in English, regardless of what language the user just wrote in.',
      });
    }

    // P1-D: routed through the single LLM chokepoint. It redacts every
    // 'user'/'assistant' message (conversation history + userMessage)
    // via redactForLLM(content, user) before this ever reaches OpenAI —
    // `user: { name: userName }` supplies the FULL stored name so any
    // mention of it in history/current text gets masked, independent of
    // the first-name-only slice already baked into the system prompt
    // above.
    const completion = await chat(messages, {
      model: 'gpt-3.5-turbo',
      max_tokens: 320,
      temperature: 0.55, // tighter than before; warmer + less rambly
      user: { name: userName },
    });

    // OpenAI's SDK types `message.content` as `string | null` (nullable
    // for tool-call-only responses). This integration never requests
    // tool calls, so content is always a string in practice — matching
    // the original JS's implicit assumption. Cast documents that, rather
    // than silently loosening this function's return type.
    return completion.choices[0].message.content as string;
  } catch (error) {
    log.error('OpenAI API error', error);
    return "I'm sorry, I'm having trouble processing your message right now. Please try again later or contact your healthcare provider if this is urgent. 💚";
  }
}
