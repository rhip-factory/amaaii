// LLM fallback for soft journal fields. Used ONLY when regex fails to
// extract the expected shape — never for triage (danger signs stay
// rule-based per spec §6.2).
//
// Calls GPT-3.5 with response_format json_object, a 3-second timeout,
// and returns null on any failure so callers can fall back to "ask the
// user to rephrase".

const OpenAI = require('openai');
const { log } = require('../utils/logger');

let cached = null;
function client() {
  if (cached) return cached;
  cached = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return cached;
}

const TIMEOUT_MS = 3000;

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
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
async function extract(instructions, userText) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const completion = await withTimeout(
      client().chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: userText },
        ],
        max_tokens: 80,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      TIMEOUT_MS
    );
    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    log.warn('LLM extraction failed', { error: err.message });
    return null;
  }
}

// ---- Field-specific extractors -------------------------------------------

// Mood 1-10. Returns { mood: int|null }.
async function extractMood(text) {
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
async function extractSleep(text) {
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
  const result = {};
  if (Number.isInteger(out.quality) && out.quality >= 1 && out.quality <= 10) result.quality = out.quality;
  if (typeof out.hours === 'number' && out.hours >= 0 && out.hours <= 24) result.hours = out.hours;
  return Object.keys(result).length ? result : null;
}

// Water glasses. Returns { glasses: int|null }.
async function extractWater(text) {
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
async function extractAppetite(text) {
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
async function extractMovement(text) {
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
async function extractMedicalHistory(text) {
  if (!process.env.OPENAI_API_KEY) return null;
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

Examples:
- "I'm 28, this is my second pregnancy, I had a C-section last time because of pre-eclampsia. I take folic acid daily and have hypertension on labetalol. I'm allergic to penicillin." →
{"gravida":2,"parity":1,"miscarriages":null,"previous_deliveries":[{"mode":"cesarean","complications":"pre-eclampsia","year":null}],"chronic_conditions":["hypertension"],"past_complications":["pre-eclampsia"],"medications":["folic acid","labetalol"],"allergies":["penicillin"],"lifestyle":{"smoking":null,"alcohol":null}}

- "Hii ni mimba yangu ya kwanza. Sina magonjwa, lakini nilikuwa na hedhi nzito." →
{"gravida":1,"parity":0,"miscarriages":null,"previous_deliveries":[],"chronic_conditions":[],"past_complications":[],"medications":[],"allergies":[],"lifestyle":{"smoking":null,"alcohol":null}}`;

  try {
    const completion = await withTimeout(
      client().chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: text },
        ],
        max_tokens: 500,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      8000  // longer budget for the bigger payload
    );
    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Soft normalization: strip empty arrays / nulls so callers get a tidy object.
    for (const key of Object.keys(parsed)) {
      if (Array.isArray(parsed[key]) && parsed[key].length === 0) delete parsed[key];
      if (parsed[key] === null) delete parsed[key];
    }
    return parsed;
  } catch (err) {
    log.warn('Medical history extraction failed', { error: err.message });
    return null;
  }
}

module.exports = {
  extract,
  extractMood,
  extractSleep,
  extractWater,
  extractAppetite,
  extractMovement,
  extractMedicalHistory,
};
