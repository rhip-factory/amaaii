// P1-E: ported 1:1 from services/llmExtract.js (final step of the TS
// migration — see CLAUDE.md). LLM fallback for soft journal fields. Used
// ONLY when regex fails to extract the expected shape. The one triage use
// is assessUrgency() below, and it can only RAISE the deterministic
// rules' urgency, never lower it (see messageHandler.ts#llmTriageRaise).
//
// Calls the extraction model (LLM_EXTRACT_MODEL, else the app model) with
// response_format json_object, a 6-second timeout, and returns null on any
// failure so callers can fall back to "ask the user to rephrase".
//
// json_object is only a request: OpenAI honors it, but Claude models via
// OpenRouter were seen wrapping the JSON in prose or a ```json fence, or
// appending text after it — hence parseJsonReply() instead of a bare
// JSON.parse().
//
// The OpenAI SDK is not imported here — every completion request goes
// through the single chokepoint in packages/adapters/src/llm.ts (P1-D's
// "LLM redaction layer"), which redacts message content before it
// reaches OpenAI and owns the lazy client init itself.

import { chat, isLlmConfigured } from '@amaaii/adapters';
import { log } from './logger';

// The mother is waiting on this, so it stays tight — but 3s was clipping
// healthy OpenRouter calls that finish in 1–3s.
const TIMEOUT_MS = 6000;
const MEDICAL_HISTORY_TIMEOUT_MS = 12000; // bigger payload, bigger reply

/**
 * Pulls the JSON object out of a model reply: the whole reply if it parses,
 * else a ```json fenced block, else the first balanced `{...}` that parses.
 * Throws when there's none, so callers' existing catch-and-log path runs.
 */
export function parseJsonReply(raw: string): any {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the lenient paths
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through
    }
  }
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break; // try the next '{'
        }
      }
    }
  }
  throw new Error('no JSON object in LLM reply');
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('llm_timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Generic helper. `instructions` should describe the field shape;
// `userText` is the message we couldn't parse. Returns the parsed JSON
// or null.
//
// Return type is `Promise<any>` deliberately: this is a raw
// `JSON.parse()` of free-form LLM output, genuinely dynamic in shape.
// Every field-specific extractor below does its own runtime validation
// on the result before trusting a field — exactly mirroring the
// original JS, which never had a static shape here either.
export async function extract(
  instructions: string,
  userText: string,
  opts: { purpose?: 'extract' | 'clarify'; timeoutMs?: number } = {}
): Promise<any> {
  if (!isLlmConfigured()) return null;
  try {
    const completion = await withTimeout(
      chat(
        [
          { role: 'system', content: instructions },
          { role: 'user', content: userText },
        ],
        {
          model: 'gpt-3.5-turbo',
          // 80 was enough for gpt-3.5, but Claude models spend tokens
          // reasoning even at minimal effort and then return nothing: 194
          // of 227 extractions came back empty at 80, and 117 of 870 still
          // did at 300 (the longer triage/onboarding prompts). Only
          // generated tokens are billed, so the headroom is nearly free.
          max_tokens: 600,
          temperature: 0,
          response_format: { type: 'json_object' },
          purpose: opts.purpose ?? 'extract',
        }
      ),
      opts.timeoutMs ?? TIMEOUT_MS
    );
    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) return null;
    return parseJsonReply(raw);
  } catch (err) {
    log.warn('LLM extraction failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ---- Field-specific extractors -------------------------------------------

// Mood 1-10. Returns { mood: int|null }.
export async function extractMood(text: string): Promise<{ mood: number } | null> {
  const out = await extract(
    `You convert a user's reply into a mood score for a daily wellbeing journal.
Return strict JSON: {"mood": <integer 1-10 or null>}.
Examples:
- "feels like a 4" -> {"mood": 4}
- "today was rough, maybe a 3" -> {"mood": 3}
- "ninajisikia vibaya, kama 2" -> {"mood": 2}
- "amazing, 9 out of 10" -> {"mood": 9}
- "no idea" -> {"mood": null}`,
    text
  );
  if (!out) return null;
  const n = Number.isInteger(out.mood) ? out.mood : null;
  if (n != null && n >= 1 && n <= 10) return { mood: n };
  return null;
}

// Sleep. Returns { quality: int|null, hours: number|null }.
export async function extractSleep(text: string): Promise<{ quality?: number; hours?: number } | null> {
  const out = await extract(
    `Extract a user's sleep details for a daily wellbeing journal.
Return strict JSON: {"quality": <integer 1-10 or null>, "hours": <number or null>}.
Quality is a self-rated score 1-10 if mentioned. Hours is hours of sleep.
Examples:
- "sleep is a 2, slept 4 hours" -> {"quality": 2, "hours": 4}
- "slept like 6 and a half hours" -> {"quality": null, "hours": 6.5}
- "really bad, only 3 hours" -> {"quality": null, "hours": 3}
- "nililala kama saa nne" -> {"quality": null, "hours": 4}
- "sikulala vizuri, niliamka mara nyingi" -> {"quality": null, "hours": null}`,
    text
  );
  if (!out) return null;
  const result: { quality?: number; hours?: number } = {};
  if (Number.isInteger(out.quality) && out.quality >= 1 && out.quality <= 10) result.quality = out.quality;
  if (typeof out.hours === 'number' && out.hours >= 0 && out.hours <= 24) result.hours = out.hours;
  return Object.keys(result).length ? result : null;
}

// Water glasses. Returns { glasses: int|null }.
export async function extractWater(text: string): Promise<{ glasses: number } | null> {
  const out = await extract(
    `Extract glasses of water consumed today.
Return strict JSON: {"glasses": <integer or null>}.
Examples:
- "like 4" -> {"glasses": 4}
- "a lot, maybe 10" -> {"glasses": 10}
- "kama glasi tano" -> {"glasses": 5}
- "barely any" -> {"glasses": 0}`,
    text
  );
  if (!out) return null;
  const n = Number.isInteger(out.glasses) ? out.glasses : null;
  if (n != null && n >= 0 && n <= 30) return { glasses: n };
  return null;
}

// Appetite. Returns { appetite: 'good'|'moderate'|'poor'|null }.
export async function extractAppetite(text: string): Promise<{ appetite: 'good' | 'moderate' | 'poor' } | null> {
  const out = await extract(
    `Classify appetite into one of: "good", "moderate", "poor".
Return strict JSON: {"appetite": "good"|"moderate"|"poor"|null}.
Examples:
- "ate a lot, felt great" -> {"appetite": "good"}
- "didn't really feel like eating" -> {"appetite": "poor"}
- "average, nothing special" -> {"appetite": "moderate"}
- "nilikuwa na njaa sana" -> {"appetite": "good"}
- "sikuwa na hamu kabisa" -> {"appetite": "poor"}`,
    text
  );
  if (!out) return null;
  if (['good', 'moderate', 'poor'].includes(out.appetite)) return { appetite: out.appetite };
  return null;
}

// Baby movement count. Returns { count: int|null }.
export async function extractMovement(text: string): Promise<{ count: number } | null> {
  const out = await extract(
    `Extract the count of fetal movements the user noticed today.
Return strict JSON: {"count": <integer or null>}.
Examples:
- "felt the baby move maybe 12 times" -> {"count": 12}
- "lost count, lots of kicks" -> {"count": 20}
- "nothing today" -> {"count": 0}
- "haven't really paid attention" -> {"count": null}`,
    text
  );
  if (!out) return null;
  const n = Number.isInteger(out.count) ? out.count : null;
  if (n != null && n >= 0 && n <= 200) return { count: n };
  return null;
}

// Medical history (Phase D). Larger payload, longer timeout.
export async function extractMedicalHistory(text: string): Promise<Record<string, unknown> | null> {
  if (!isLlmConfigured()) return null;
  const instructions = `You convert a free-text obstetric/medical narrative from a pregnant or postpartum mother into a structured profile.

Return STRICT JSON with this exact shape (omit fields the user didn't mention; never invent):
{
  "gravida": <int|null>,
  "parity": <int|null>,
  "miscarriages": <int|null>,
  "previous_deliveries": [
    {"mode": "vaginal"|"cesarean"|"assisted"|null, "complications": "<short string|null>", "year": <int|null>}
  ],
  "chronic_conditions": ["hypertension", "type 2 diabetes", ...],
  "past_complications": ["pre-eclampsia", "gestational diabetes", "preterm labor", ...],
  "medications": ["folic acid", "labetalol", ...],
  "allergies": ["penicillin", ...],
  "lifestyle": {"smoking": <bool|null>, "alcohol": <bool|null>}
}

CRITICAL RULE FOR COMPLICATIONS:
- When a complication is described alongside a specific delivery
  ("the first had pre-eclampsia", "C-section due to pre-eclampsia",
  "second baby had gestational diabetes"), you MUST set the
  complications field on THAT delivery's object, AND also add it to
  the top-level past_complications array. Both places — never just one.
- Use the order the deliveries are described (first mentioned = index 0).
- If a complication is mentioned without tying to a specific pregnancy
  ("I've had pre-eclampsia before"), only add it to past_complications.

EXAMPLES (study the previous_deliveries[].complications carefully):

Input: "I'm 28, this is my second pregnancy, I had a C-section last time because of pre-eclampsia. I take folic acid daily and have hypertension on labetalol. I'm allergic to penicillin."
Output: {"gravida":2,"parity":1,"previous_deliveries":[{"mode":"cesarean","complications":"pre-eclampsia","year":null}],"chronic_conditions":["hypertension"],"past_complications":["pre-eclampsia"],"medications":["folic acid","labetalol"],"allergies":["penicillin"],"lifestyle":{"smoking":null,"alcohol":null}}

Input: "4th pregnancy. 2 living children, both C-sections. First had pre-eclampsia at 36 weeks. Second was a planned C-section. One miscarriage at 8 weeks. Type 2 diabetes on metformin, on folic acid and aspirin. No allergies."
Output: {"gravida":4,"parity":2,"miscarriages":1,"previous_deliveries":[{"mode":"cesarean","complications":"pre-eclampsia","year":null},{"mode":"cesarean","complications":"planned","year":null}],"chronic_conditions":["type 2 diabetes"],"past_complications":["pre-eclampsia"],"medications":["metformin","folic acid","aspirin"],"allergies":[],"lifestyle":{"smoking":null,"alcohol":null}}

Input: "I had a baby vaginally last year, no problems, and a year before that I lost a pregnancy at 14 weeks."
Output: {"gravida":3,"parity":1,"miscarriages":1,"previous_deliveries":[{"mode":"vaginal","complications":null,"year":null}],"past_complications":[],"lifestyle":{"smoking":null,"alcohol":null}}

Input: "Hii ni mimba yangu ya kwanza. Sina magonjwa."
Output: {"gravida":1,"parity":0,"previous_deliveries":[],"chronic_conditions":[],"past_complications":[],"medications":[],"allergies":[],"lifestyle":{"smoking":null,"alcohol":null}}

Input: "Mtoto wangu wa kwanza alizaliwa kwa upasuaji kwa sababu ya shinikizo la damu. Wa pili alizaliwa vizuri."
Output: {"gravida":3,"parity":2,"previous_deliveries":[{"mode":"cesarean","complications":"hypertension","year":null},{"mode":"vaginal","complications":null,"year":null}],"past_complications":["hypertension"],"lifestyle":{"smoking":null,"alcohol":null}}`;

  try {
    const completion = await withTimeout(
      chat(
        [
          { role: 'system', content: instructions },
          { role: 'user', content: text },
        ],
        {
          model: 'gpt-3.5-turbo',
          max_tokens: 500,
          temperature: 0,
          response_format: { type: 'json_object' },
          purpose: 'extract',
        }
      ),
      MEDICAL_HISTORY_TIMEOUT_MS
    );
    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = parseJsonReply(raw) as Record<string, unknown>;
    // Soft normalization: strip empty arrays / nulls so callers get a tidy object.
    for (const key of Object.keys(parsed)) {
      const v = parsed[key];
      if (Array.isArray(v) && v.length === 0) delete parsed[key];
      if (parsed[key] === null) delete parsed[key];
    }
    return parsed;
  } catch (err) {
    log.warn('Medical history extraction failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// Pregnancy-week / LMP extraction — used as the 3-strikes fallback in
// onboarding when regex repeatedly fails to parse the user's answer.
export async function extractWeekOrLMP(text: string): Promise<{ weeks?: number; lmp?: string } | null> {
  const today = new Date().toISOString().split('T')[0];
  const out = await extract(
    `You convert a user's reply about their pregnancy stage into structured data.
Today is ${today}.
Return STRICT JSON: {"weeks": <int 1-42|null>, "lmp": "YYYY-MM-DD"|null}.
- If they state weeks, set weeks. (Range 1-42; reject anything outside.)
- If they state a date that is their last menstrual period (LMP), set lmp.
- If they say a month name without a year, assume the most recent occurrence.
- If they say "5 months along", convert to weeks (months × 4.33, round).
- If you can't tell, return both null.

Examples:
- "22" → {"weeks": 22, "lmp": null}
- "I'm 18 weeks" → {"weeks": 18, "lmp": null}
- "5 months along" → {"weeks": 22, "lmp": null}
- "my last period was 22 march" → {"weeks": null, "lmp": "${today.slice(0, 4)}-03-22"}
- "I think I'm in my second trimester" → {"weeks": 18, "lmp": null}
- "no idea" → {"weeks": null, "lmp": null}
- "niko mwezi wa nne" (4 months in SW) → {"weeks": 17, "lmp": null}`,
    text
  );
  if (!out) return null;
  const result: { weeks?: number; lmp?: string } = {};
  if (Number.isInteger(out.weeks) && out.weeks >= 1 && out.weeks <= 42) result.weeks = out.weeks;
  if (typeof out.lmp === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(out.lmp)) result.lmp = out.lmp;
  return Object.keys(result).length ? result : null;
}

// Context-aware journal reading: the answer is read against the exact
// question Amaaii asked (the per-field extractors above see only her
// words, so "It was a 7" after the sleep question had no way to mean
// anything in particular). The caller validates every value
// (core validJournalFields) and builds any "what did you mean?" buttons
// itself; the model only proposes.
const JOURNAL_FIELD_SPEC: Record<string, string> = {
  mood: '{"mood": int 1-10 (how she feels emotionally)}',
  sleep: '{"quality": int 1-10 (how well she slept), "hours": number 0-16 (hours slept)}',
  baby_movement: '{"count": int 0-200 (times she felt the baby move today)}',
  water: '{"glasses": int 0-30 (glasses of water today)}',
  appetite: '{"appetite": "good"|"moderate"|"poor"}',
};

export interface JournalReading {
  status: 'clear' | 'ambiguous' | 'no_answer';
  answer: Record<string, unknown>;
  readings: Record<string, unknown>[];
  symptom: string;
}

export async function interpretJournalAnswer(
  stage: string,
  question: string | null,
  answer: string
): Promise<JournalReading | null> {
  const spec = JOURNAL_FIELD_SPEC[stage];
  if (!spec) return null;
  const out = await extract(
    `You read a pregnant or postpartum mother's reply during a daily check-in and record her answer to the question Amaaii asked. The answer's fields: ${spec}.
Return STRICT JSON: {"status": "clear"|"ambiguous"|"no_answer", "answer": {fields}, "readings": [{fields}], "symptom": string}
- clear: the reply answers the question in one way. Put the values she gave in "answer"; leave out any field she did not give.
- ambiguous: the SAME words could be different values, e.g. one bare number when the question asked for two values. Put up to 2 possible answers in "readings", most likely first. A value she simply did not give is not ambiguity: that is "clear" with only the values she gave.
- no_answer: she did not answer it (a question back, a new topic, or no value at all).
- symptom: if she mentions a physical symptom or feeling unwell (pain, bleeding, headache, fever...), name it in a few words; otherwise "".
Never invent a value she did not give. Replies may be in English, Kiswahili or Sheng; Kiswahili hours: "saa nne" = 4 hours.`,
    `Amaaii asked:\n"""${(question ?? '').slice(0, 500)}"""\n\nHer reply:\n"""${answer}"""`
  );
  if (!out || typeof out !== 'object') return null;
  const status = out.status === 'clear' || out.status === 'ambiguous' || out.status === 'no_answer' ? out.status : null;
  if (!status) return null;
  return {
    status,
    answer: out.answer && typeof out.answer === 'object' ? out.answer : {},
    readings: Array.isArray(out.readings) ? out.readings.filter((r: unknown) => r && typeof r === 'object').slice(0, 2) : [],
    symptom: typeof out.symptom === 'string' ? out.symptom.slice(0, 60) : '',
  };
}

// "What did you mean?" for a check-in answer Haiku couldn't read for sure.
// A stronger model (LLM_CLARIFY_MODEL) either settles the value or writes
// one short question with up to two options, each carrying the exact
// fields to save. The caller validates every value and label, adds the
// "I feel unwell" option itself, and falls back to the canned question.
const CLARIFY_TIMEOUT_MS = 12000;

export interface ClarifyOptionDraft {
  label: string;
  answer: Record<string, unknown>;
}

export type ClarifyPlan =
  | { action: 'save'; answer: Record<string, unknown> }
  | { action: 'ask'; message: string; options: ClarifyOptionDraft[] }
  | { action: 'off_topic' };

export async function clarifyJournalAnswer(input: {
  stage: string;
  question: string | null;
  answer: string;
  soFar: string;
  lang: string;
}): Promise<ClarifyPlan | null> {
  const spec = JOURNAL_FIELD_SPEC[input.stage];
  if (!spec) return null;
  const language = input.lang === 'sw' ? 'Kiswahili' : 'English';
  const out = await extract(
    `You help Amaaii, a pregnancy companion for mothers in Kenya, in the middle of a mother's daily check-in on WhatsApp. The app asks fixed questions and saves her answers. Her reply to the current question could not be read for certain; you settle it.
What the app can save for this question: ${spec}.
Return STRICT JSON, one of:
{"action": "save", "answer": {fields}} - her reply does give the value, even roughly ("40 minutes" = hours 0.7; "like a 3" = 3; "maji glasi tano" = glasses 5). Only values she gave or clearly meant. A single bare number when the question asks for two values (sleep quality AND hours) is never settled: ask which she meant.
{"action": "off_topic"} - she is not trying to answer: she asks something or talks about something else. The app pauses the check-in and answers her.
{"action": "ask", "message": "...", "options": [{"label": "...", "answer": {fields}}]} - otherwise. "message": ONE short, warm question (at most 2 sentences) in ${language} that refers to her words and makes answering easy, e.g. offering the likely meanings. "options": up to 2 likely answers, each "label" at most 20 characters in ${language}, each with the exact fields to save.
Rules: you are not a nurse here. Never give medical advice or reassurance. Don't mention symptoms she didn't mention. The app adds an "I feel unwell" button itself, so never offer one. Ask about this question only. No placeholders like [NAME].`,
    `Saved so far today: ${input.soFar}\n\nThe app asked:\n"""${(input.question ?? '').slice(0, 500)}"""\n\nHer reply:\n"""${input.answer}"""`,
    { purpose: 'clarify', timeoutMs: CLARIFY_TIMEOUT_MS }
  );
  if (!out || typeof out !== 'object') return null;
  if (out.action === 'off_topic') return { action: 'off_topic' };
  if (out.action === 'save' && out.answer && typeof out.answer === 'object') {
    return { action: 'save', answer: out.answer };
  }
  if (out.action === 'ask' && typeof out.message === 'string') {
    const options: ClarifyOptionDraft[] = Array.isArray(out.options)
      ? (out.options as unknown[])
        .filter((o): o is { label: string; answer: Record<string, unknown> } =>
          !!o && typeof o === 'object' &&
          typeof (o as { label?: unknown }).label === 'string' &&
          !!(o as { answer?: unknown }).answer && typeof (o as { answer?: unknown }).answer === 'object')
        .slice(0, 2)
        .map((o) => ({ label: o.label, answer: o.answer }))
      : [];
    return { action: 'ask', message: out.message, options };
  }
  return null;
}

// Raise-only safety net over the deterministic danger rules (2026-10
// simulation: the rules caught 8/34 scripted emergencies; the AI reply
// often told her to go to hospital anyway, but nothing escalated —
// no follow-up job, no audit row, no provider feed). The caller only ever
// uses this to RAISE urgency; a null / error / timeout means "no raise".
export type LlmUrgency = 'low' | 'moderate' | 'high' | 'critical';

export async function assessUrgency(
  message: string,
  context: { pregnancyWeek?: number | null; postpartumDays?: number | null; askedQuestion?: string | null } = {}
): Promise<{ urgency: LlmUrgency; reason: string } | null> {
  const stage = context.postpartumDays != null
    ? `She gave birth ${context.postpartumDays} days ago.`
    : context.pregnancyWeek != null
      ? `She is about ${context.pregnancyWeek} weeks pregnant.`
      : 'Her pregnancy stage is unknown.';
  const out = await extract(
    `You are a triage nurse for pregnant and postpartum women in Kenya. Classify ONLY what the mother says is happening to her (or her newborn) NOW. ${stage}
Return STRICT JSON: {"urgency": "low"|"moderate"|"high"|"critical", "reason": "<max 12 words>"}.
- critical: needs emergency care now — heavy bleeding, soaked pads, seizures, fainting, severe headache with vision changes or BP >= 160/110, water broke, severe abdominal pain after a blow, baby not moving for hours late in pregnancy, chest pain or can't breathe, thoughts of suicide or harming the baby (including "better off without me"), newborn not breathing/blue/fitting.
- high: needs a health worker TODAY — any bleeding or spotting, fever, reduced baby movements, regular contractions before 37 weeks, vomiting so she can't keep water down, swelling of face/hands, BP 140-159/90-109, violence against her, a fall, wound redness with fever, newborn not feeding, yellow, floppy or with fever.
- moderate: worth mentioning at the next clinic visit.
- low: everything else, INCLUDING symptoms she denies ("no bleeding"), things that already stopped, hypotheticals ("if I bleed what do I do"), general questions about other people, and normal pregnancy discomforts.
- Her message may answer Amaaii's last message. Read a number or rating as the answer to that question (a sleep or mood score is not a pain score), and never classify a symptom she did not mention.
Messages may be in English, Kiswahili or Sheng.`,
    context.askedQuestion
      ? `Amaaii's last message to her:\n"""${context.askedQuestion.slice(0, 500)}"""\n\nHer reply:\n"""${message}"""`
      : message
  );
  if (!out || typeof out.urgency !== 'string') return null;
  const urgency = out.urgency.toLowerCase();
  if (!['low', 'moderate', 'high', 'critical'].includes(urgency)) return null;
  return { urgency: urgency as LlmUrgency, reason: typeof out.reason === 'string' ? out.reason.slice(0, 120) : '' };
}

// LLM-first onboarding: one call reads every profile fact a mother put in
// a free-text message ("Mimi ni Wanjiru, nina miaka 19, mimba ya miezi
// mitano, niko Kisumu"), in any language. The caller validates every field
// in plain code before saving anything — the model only proposes.
export interface OnboardingSlots {
  name?: string;
  age?: number;
  weeks?: number;
  months?: number;
  lmp?: string;
  edd?: string;
  location?: string;
  language?: 'en' | 'sw';
  babyBorn?: boolean;
  deliveryDate?: string;
  babyAgeDays?: number;
}

export async function extractOnboardingSlots(text: string, missing: string[]): Promise<OnboardingSlots | null> {
  const today = new Date().toISOString().split('T')[0];
  const out = await extract(
    `You read a Kenyan mother's WhatsApp message to a pregnancy helper and pull out profile facts she CLEARLY states about herself. Today is ${today}. Still needed: ${missing.join(', ')}.
Return STRICT JSON with only the keys you are sure of (omit the rest):
{"name": string, "age": int, "weeks": int, "months": number, "lmp": "YYYY-MM-DD", "edd": "YYYY-MM-DD", "location": string, "language": "en"|"sw", "babyBorn": bool, "deliveryDate": "YYYY-MM-DD", "babyAgeDays": int}
Rules:
- name: only if she introduces herself ("I'm Faith", "naitwa Wanjiru", "ni mimi Akinyi"). Never a word like "pregnant" or "fine".
- age: her age in years only. Never a medicine dose, a week count or a month count.
- weeks/months: how far along the pregnancy is ("5 months" -> months 5, "wiki 20" -> weeks 20, "mwezi wa nne" -> months 3.5). lmp = last period date; edd = due date.
- babyBorn: true if the baby has already been born ("nimejifungua", "I gave birth", "my baby is 2 weeks old"); then deliveryDate or babyAgeDays.
- location: town/area she lives in ("Kisumu", "Kibera, Nairobi", "Homa Bay"). Not a hospital she is visiting.
- language: "sw" if she writes mainly in Kiswahili or asks for Kiswahili; "en" if mainly English.
- Kiswahili numbers: moja 1, mbili 2, tatu 3, nne 4, tano 5, sita 6, saba 7, nane 8, tisa 9, kumi 10, ishirini 20, thelathini 30, arobaini 40; "kumi na tisa" = 19.`,
    text
  );
  if (!out || typeof out !== 'object') return null;
  const r: OnboardingSlots = {};
  const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (typeof out.name === 'string' && out.name.trim()) r.name = out.name.trim();
  if (Number.isInteger(out.age)) r.age = out.age;
  if (Number.isInteger(out.weeks)) r.weeks = out.weeks;
  if (typeof out.months === 'number' && Number.isFinite(out.months)) r.months = out.months;
  if (isDate(out.lmp)) r.lmp = out.lmp;
  if (isDate(out.edd)) r.edd = out.edd;
  if (typeof out.location === 'string' && out.location.trim()) r.location = out.location.trim();
  if (out.language === 'sw' || out.language === 'en') r.language = out.language;
  if (out.babyBorn === true) r.babyBorn = true;
  if (isDate(out.deliveryDate)) r.deliveryDate = out.deliveryDate;
  if (Number.isInteger(out.babyAgeDays)) r.babyAgeDays = out.babyAgeDays;
  return Object.keys(r).length ? r : null;
}
