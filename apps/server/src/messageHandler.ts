// P1-E: ported 1:1 from utils/messageHandler.js (final step of the TS
// migration — see CLAUDE.md). Deterministic onboarding parsers
// (cleanName, parseWeekOrLMP, weeksFromLMP, inferLMPYear,
// calculateEDDFromWeeks) live in packages/core/src/onboarding.ts. The
// 3-strikes LLM fallback stays here, since it's orchestration (reads
// conversation history from the DB, calls ./llmExtract).

import { sendWhatsAppButtons, sendWhatsAppMessage } from '@amaaii/adapters';
import { getAmaaiiResponse } from './amaaii';
import {
  detectDangerSigns,
  assessMood,
  extractSymptoms,
  t,
  pickLang,
  dangerCopy,
  dangerRepeatCopy,
  escalationVariant,
  parseCommand,
  isGoAhead,
  isLocationRefusal,
  isWhyAskQuestion,
  asksForHelp,
  offersJournal,
  offeredActions,
  checkinStageLabel,
  isJournalSessionStale,
  parseProfileUpdate,
  pregnancyStatus,
  detectLanguage,
  cleanName,
  parseWeekOrLMP,
  parseAge,
  calculateEDDFromWeeks,
  CONSENT_VERSION,
  deriveConsentState,
  needsConsent,
  canUseAi,
  classifyConsentReply,
  withOptionList,
  actionButtonsFor,
  withButtonHint,
  JOURNAL_SCORE_STAGES,
} from '@amaaii/core';
import type { UpdateUserInput, ConsentState, DangerSignResult } from '@amaaii/core';
import userManager, { type UserWithFlag } from './userManager';
import * as db from './database';
import journalManager from './journalManager';
import { log } from './logger';
import { getRecentTrend, trendForPrompt } from './trend';
import * as llm from './llmExtract';
import { recordAuditSafe, auditDangerEscalation } from './audit';

// We compare against BOTH the EN and SW reminder markers when checking
// "did we already nudge the user this session?" — language can change
// between turns.
// Fixed openings rather than the whole string, so a reminder sent before
// the copy changed ("Type 'journal'" became "Tap *Start journal*") counts.
// The AI-off reply, current and before the "Turn on AI replies" button.
const AI_OFF_MARKERS = [
  "I can't write you a personal answer",
  'Siwezi kukuandikia jibu lako binafsi',
  'AI-powered replies are turned off',
  'Majibu ya AI yamezimwa. Unaweza',
];

const JOURNAL_WORDS = /\b(?:journal|jarida|check-?\s?in|ukaguzi)\b/i;

const JOURNAL_REMINDER_MARKERS = [
  "Don't forget to do your daily journal!",
  'Usisahau kufanya jarida lako la kila siku!',
];

// --- Consent gate (P3-B) -----------------------------------------------
// Fixed, var-free substrings of consent_request/consent_reprompt (both
// strings interpolate {url}, so the rendered text itself can't be used
// as a marker the way NAME_PROMPT_MARKERS reuses the full literal
// name_prompt string) — same "was the bot's last message asking X?"
// detection pattern as NAME_PROMPT_MARKERS / WEEK_PROMPT_MARKERS
// below, kept stateless per CLAUDE.md's onboarding design.
// "Reply *I AGREE*" became "Tap *I AGREE*" (it carries a button now); the
// shared tail matches both, so a prompt sent before the change still counts.
const CONSENT_PROMPT_MARKERS = ['*I AGREE* to continue', '*NAKUBALI* kuendelea'];
// consent_explain reuses the reprompt phrase below; consent_declined reuses
// the prompt phrase above ("Reply *I AGREE* to continue").
const CONSENT_REPROMPT_MARKERS = [
  'please tap *I AGREE*', 'tafadhali bonyeza *NAKUBALI*',
  // Before the reply buttons.
  'please reply with the word *AGREE*', 'tafadhali jibu na neno *NAKUBALI*',
];
const CONSENT_EXPLAIN_MARKERS = ['Straight answers:', 'More detail 💚', 'Majibu ya moja kwa moja:', 'Maelezo zaidi 💚'];
// consent_explain_more keeps the reprompt phrase too ("reply with the word *AGREE*").

// PUBLIC_BASE_URL is read at call time (not module load) so it can vary
// per-request in tests/dev without restarting the process. The /privacy
// page itself ships in P3-D — this only wires the mechanism (a 404 on
// that path today is expected and fine).
/** The PWA's public origin (PUBLIC_BASE_URL), or null when unset. */
export function publicBaseUrl(): string | null {
  const base = process.env.PUBLIC_BASE_URL;
  return base ? base.replace(/\/+$/, '') : null;
}

function privacyNoticeUrl(): string {
  const base = publicBaseUrl();
  if (!base) return 'the Amaaii app';
  return `${base}/privacy`;
}

/** "📱 The Amaaii app: <url> …" — only when the app has a public URL. */
function appLine(lang: string): string {
  const url = publicBaseUrl();
  return url ? `\n\n${t(lang, 'help_app_line', { appUrl: url })}` : '';
}

async function loadConsentState(phoneNumber: string): Promise<ConsentState> {
  return deriveConsentState(await db.getConsents(phoneNumber));
}

// --- Raise-only AI triage -------------------------------------------------
// The deterministic rules stay authoritative and always run first. This
// asks the extraction model for a second opinion ONLY when the rules said
// low/moderate, and its answer can only RAISE the turn's urgency (to HIGH
// by default; LLM_TRIAGE_MAX=critical allows CRITICAL). It never lowers
// anything, never runs without the optional ai_responses consent, and any
// error/timeout means "no raise". Kill switch: LLM_TRIAGE_RAISE=0.
const URGENCY_RANK: Record<string, number> = { low: 0, moderate: 1, high: 2, critical: 3 };

function llmTriageEnabled(): boolean {
  const flag = (process.env.LLM_TRIAGE_RAISE ?? '').toLowerCase();
  return flag !== '0' && flag !== 'false' && flag !== 'off';
}

export async function llmTriageRaise(
  message: string,
  rulesUrgency: string,
  pregnancyWeek: number | null | undefined,
  phone?: string,
  opts: { force?: boolean } = {}
): Promise<DangerSignResult | null> {
  if (!llmTriageEnabled()) return null;
  if ((URGENCY_RANK[rulesUrgency] ?? 0) >= URGENCY_RANK.high) return null;
  // Greetings, numbers and one-word journal answers carry nothing to triage
  // — unless she just said she is unwell ("Pain 7/10" from a button).
  if (!opts.force && message.trim().split(/\s+/).filter(Boolean).length < 4) return null;
  try {
    // The model must see what she is answering: alone, "It was a 7" (her
    // sleep score) was read as "pain rated 7/10" and escalated in prod.
    const askedQuestion = phone ? (await db.getLastBotMessage(phone).catch(() => null))?.response ?? null : null;
    const out = await llm.assessUrgency(message, { pregnancyWeek, askedQuestion });
    if (!out) return null;
    const cap = (process.env.LLM_TRIAGE_MAX ?? '').toLowerCase() === 'critical' ? 'critical' : 'high';
    const level = URGENCY_RANK[out.urgency] > URGENCY_RANK[cap] ? cap : out.urgency;
    if (URGENCY_RANK[level] < URGENCY_RANK.high || URGENCY_RANK[level] <= (URGENCY_RANK[rulesUrgency] ?? 0)) {
      return null;
    }
    const urgencyLevel = level as 'high' | 'critical';
    return {
      detectedSigns: [{ sign: `AI triage: ${out.reason}`.trim(), level: urgencyLevel }],
      urgencyLevel,
      requiresUrgentCare: true,
      recommendedAction: '',
    };
  } catch (err) {
    log.warn('LLM triage raise failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// The baby is already here — in any phrasing parseProfileUpdate's
// stricter BIRTH pattern might miss.
const BIRTH_CUE = /\b(?:born|delivered|gave\s+birth|nimejifungua|nilijifungua|amezaliwa|alizaliwa|nimezaa)\b/i;

const DELIVERY_ASK_MARKERS = [t('en', 'delivery_ask').slice(0, 40), t('sw', 'delivery_ask').slice(0, 40)];

// When was the baby born? "yesterday"/"jana" and "N days ago"/"siku N"
// deterministically; otherwise the extraction model; otherwise today.
async function birthDateFrom(message: string, canAi: boolean): Promise<string> {
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const lower = message.toLowerCase();
  if (/\b(?:yesterday|jana)\b/.test(lower)) return iso(new Date(now.getTime() - dayMs));
  const ago = lower.match(/\b(\d{1,2})\s*(?:days?\s+ago|siku\s+(?:zilizopita|iliyopita))\b/) || lower.match(/\bsiku\s+(\d{1,2})\s+zilizopita\b/);
  if (ago) return iso(new Date(now.getTime() - parseInt(ago[1], 10) * dayMs));
  const weeksAgo = lower.match(/\b(\d{1,2}|one|two|three|four|five|six)\s*weeks?\s+(?:ago|old)\b/) || lower.match(/\bwiki\s+(\d{1,2}|mbili|tatu|nne|tano|sita)\s+(?:zilizopita|iliyopita)\b/);
  if (weeksAgo) {
    const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, mbili: 2, tatu: 3, nne: 4, tano: 5, sita: 6 };
    const n = WORDS[weeksAgo[1]] ?? parseInt(weeksAgo[1], 10);
    if (n >= 0 && n <= 52) return iso(new Date(now.getTime() - n * 7 * dayMs));
  }
  if (/\b(?:today|leo|this\s+morning|asubuhi\s+hii)\b/.test(lower)) return iso(now);
  if (!canAi) return iso(now);
  const out = await llm.extractOnboardingSlots(message, ['week']).catch(() => null);
  if (out?.deliveryDate) {
    const days = Math.floor((now.getTime() - Date.parse(`${out.deliveryDate}T00:00:00Z`)) / dayMs);
    if (days >= 0 && days <= 365) return out.deliveryDate;
  }
  if (out?.babyAgeDays != null && out.babyAgeDays >= 0 && out.babyAgeDays <= 365) {
    return iso(new Date(now.getTime() - out.babyAgeDays * dayMs));
  }
  return iso(now);
}

// She mentioned a condition (HIV, twins, a stillbirth, high blood pressure…)
// in chat. The only writer of medical_history used to be the PWA form, so
// the AI forgot these within three turns. Background, best-effort: merge
// what the extractor finds into the stored record.
const CONDITION_WORDS = /\b(?:hiv|arvs?|tld|diabetes|diabetic|kisukari|sugar|pressure|presha|hypertension|anaemia|anemia|twins|mapacha|stillbirth|still\s*born|miscarriage|miscarried|c-?section|caesarean|cesarean|upasuaji|asthma|pumu|epilepsy|kifafa|sickle|thyroid|pre-?eclampsia|methyldopa|nifedipine|labetalol|metformin|insulin|ivf|allergic|allergy)\b/i;

function mergeHistory(existing: Record<string, unknown>, found: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(found)) {
    const prev = merged[key];
    if (Array.isArray(value)) {
      const seen = new Set((Array.isArray(prev) ? prev : []).map((v) => JSON.stringify(v)));
      merged[key] = [...(Array.isArray(prev) ? prev : []), ...value.filter((v) => !seen.has(JSON.stringify(v)))];
    } else if (prev == null) {
      merged[key] = value;
    }
  }
  return merged;
}

export function captureMedicalHistory(phone: string, message: string): Promise<void> | null {
  if (!CONDITION_WORDS.test(message)) return null;
  return (async () => {
    try {
      const found = await llm.extractMedicalHistory(message);
      if (!found || Object.keys(found).length === 0) return;
      const existing = await db.getMedicalHistory(phone);
      const { rawText, updatedAt: _updatedAt, ...extracted } = existing || { rawText: null, updatedAt: '' };
      const raw = [rawText, `[chat] ${message}`].filter(Boolean).join('\n').slice(-4000);
      await db.saveMedicalHistory(phone, { rawText: raw, extracted: mergeHistory(extracted, found) });
    } catch (err) {
      log.warn('Medical history capture failed', { error: err instanceof Error ? err.message : String(err) });
    }
  })();
}

// Did the AI reply already tell her to get care now? Then the canned
// escalation copy isn't prepended on top of it (urgency is still raised).
function advisesCareNow(reply: string): boolean {
  return /\b(?:hospital|clinic|facility|health\s+(?:centre|center|worker|provider)|999|hospitali|kliniki|kituo\s+cha\s+afya)\b/i.test(reply)
    && /\b(?:now|today|immediately|right\s+away|tonight|sasa|leo|haraka|mara\s+moja)\b/i.test(reply);
}

// Stateless consent gate for the WhatsApp channel — re-reads state each
// turn, same design as handleOnboarding below. Grants BOTH purposes on
// agreement (see the file-level note near processMessage for why the
// WhatsApp channel differs from the web PWA here): the WhatsApp bot IS
// an AI chat, so there's no meaningful "use WhatsApp without AI replies"
// state the way there is on the web PWA's structured check-in form.
async function handleConsentGate(
  message: string,
  phoneNumber: string,
  lang: string
): Promise<{ response: string; granted: boolean }> {
  const lastBot = await db.getLastBotMessage(phoneNumber);
  const lastResp = lastBot?.response || '';
  const alreadyPrompted =
    CONSENT_PROMPT_MARKERS.some((m) => lastResp.includes(m)) ||
    CONSENT_REPROMPT_MARKERS.some((m) => lastResp.includes(m));

  const reply = classifyConsentReply(message);

  if (reply === 'decline') {
    // An explicit no. Recorded (append-only ledger) so the decision is
    // auditable; the gate keeps answering danger signs regardless.
    await db.recordConsent(phoneNumber, 'data_processing', false, CONSENT_VERSION);
    await recordAuditSafe({
      actor: phoneNumber,
      action: 'consent_revoke',
      resource: 'consent',
      resourceOwner: phoneNumber,
      metadata: { purpose: 'data_processing', granted: false, channel: 'whatsapp', via: 'decline_reply' },
    });
    return { response: t(lang, 'consent_declined'), granted: false };
  }

  if (alreadyPrompted && reply === 'question') {
    // A second question gets more detail, not the same text again (the
    // simulation's mothers were sent one canned answer six times).
    const gaveFirst = CONSENT_EXPLAIN_MARKERS.slice(0, 1).concat(CONSENT_EXPLAIN_MARKERS[2]).some((m) => lastResp.includes(m));
    return {
      response: t(lang, gaveFirst ? 'consent_explain_more' : 'consent_explain', { url: privacyNoticeUrl() }),
      granted: false,
    };
  }

  if (alreadyPrompted && reply === 'grant') {
    await db.recordConsent(phoneNumber, 'data_processing', true, CONSENT_VERSION);
    await db.recordConsent(phoneNumber, 'ai_responses', true, CONSENT_VERSION);
    await recordAuditSafe({
      actor: phoneNumber,
      action: 'consent_grant',
      resource: 'consent',
      resourceOwner: phoneNumber,
      metadata: { purpose: 'data_processing', granted: true, channel: 'whatsapp' },
    });
    await recordAuditSafe({
      actor: phoneNumber,
      action: 'consent_grant',
      resource: 'consent',
      resourceOwner: phoneNumber,
      metadata: { purpose: 'ai_responses', granted: true, channel: 'whatsapp' },
    });
    return { response: t(lang, 'consent_thanks'), granted: true };
  }

  if (alreadyPrompted) {
    // Negative or unrecognized reply to an already-issued prompt: switch
    // to (and keep repeating) the clearer re-prompt. Never advance to
    // onboarding without an explicit affirmative — see the work order's
    // "do not proceed to onboarding without consent" requirement.
    return { response: t(lang, 'consent_reprompt', { url: privacyNoticeUrl() }), granted: false };
  }

  // Brand-new: this phone has never been asked.
  return { response: t(lang, 'consent_request', { url: privacyNoticeUrl() }), granted: false };
}

export interface ProcessMessageResult {
  response: string;
  urgencyLevel: string;
  context: string;
  /** true only for the web /chat "you need to consent first" response —
   *  never set for the WhatsApp channel (which handles the same gate
   *  conversationally instead). */
  consentRequired?: boolean;
  /** true only when the AI chokepoint (getAmaaiiResponse) actually ran
   *  this turn — lets callers (POST /chat's audit wiring) log 'ai_call'
   *  vs a plain 'write' without re-deriving consent state themselves. */
  aiUsed?: boolean;
  /** A reply with buttons: WhatsApp reply buttons and the app's chips.
   *  For a "what did you mean?" question, `response` is the text form with
   *  a numbered list (what history stores, and what any transport without
   *  buttons sends) and `body` is the question alone. For a canned prompt
   *  that asks for a word ("tap *None*"), `body` is `response` and
   *  `fallback` is the text form for a transport without buttons. */
  buttons?: { body: string; options: string[]; fallback?: string };
}

// Canned prompts that ask her to send a word get that word as buttons.
function withActionButtons(result: ProcessMessageResult): ProcessMessageResult {
  if (result.buttons || result.consentRequired) return result;
  const actions = actionButtonsFor(result.response);
  if (!actions) return result;
  return {
    ...result,
    buttons: { body: result.response, options: actions.options, fallback: withButtonHint(result.response, actions) },
  };
}

export interface ProcessMessageOptions {
  /** Defaults to 'whatsapp' (existing callers/behavior unchanged). The
   *  web PWA's POST /chat passes 'web' explicitly — see rule (b) in the
   *  consent-gate block below for why the two channels diverge on a
   *  non-consented user. */
  channel?: 'whatsapp' | 'web';
}

// Pure(-ish) message processor: derives the bot's response from the
// inbound message + DB state, persists the turn, and returns the result.
// No outbound transport (Twilio / HTTP) — callers handle delivery.
export async function processMessage(
  from: string,
  message: string,
  profileName: string | null,
  opts: ProcessMessageOptions = {}
): Promise<ProcessMessageResult> {
  const channel = opts.channel ?? 'whatsapp';
  log.info(`Processing message from ${from}`, { profileName, message });

  const user = await userManager.getOrCreateUser(from, profileName);
  const userContext = userManager.getUserContext(user);
  let lang = pickLang(user.language);

  // While she is new (consent + onboarding) on WhatsApp, follow the
  // language she writes in. Afterwards it changes only when she asks
  // ("Kiswahili tafadhali"), so code-switching doesn't flip it.
  if (channel === 'whatsapp' && userContext.needsOnboarding) {
    const detected = detectLanguage(message);
    if (detected && detected !== lang) {
      await db.updateUser(from, { language: detected });
      user.language = detected;
      lang = detected;
    }
  }

  log.info('User context', userContext);

  let response = '';
  let conversationContext = 'general';
  let dangerSignAnalysis: ReturnType<typeof detectDangerSigns> | null = null;
  // Set below only when the WhatsApp consent gate grants consent THIS
  // turn for an already-onboarded (returning) user — see the gate block
  // and its application further down.
  let consentGrantedPrefix = '';
  // True only when getAmaaiiResponse (the LLM chokepoint) actually runs
  // this turn — see ProcessMessageResult.aiUsed.
  let aiUsed = false;

  // CRITICAL danger signs short-circuit everything, including consent —
  // Kenya DPA vital-interests basis (see CLAUDE.md / the P3-B work
  // order). `earlyDanger` is reused as `dangerSignAnalysis` further down,
  // and a CRITICAL/HIGH message interrupts an open journal session, so it
  // always lands in the escalation branch — nothing below this line is
  // allowed to intercept it.
  const earlyDanger = detectDangerSigns(message);

  // --- Consent gate (P3-B) --------------------------------------------
  // Sits BEFORE profile onboarding but AFTER the CRITICAL bypass above.
  // HIGH/MODERATE danger copy is still prepended here, same as the
  // onboarding block below — consent status never suppresses escalation
  // copy, only ever gates the AI/profile/journaling features layered on
  // top of it.
  //
  // Storage note: while consent is outstanding we skip saveConversation
  // (and saveSymptoms) entirely — "do the minimum storage needed" per
  // the work order. The only unavoidable write is the user row itself
  // (already created by getOrCreateUser above), which is what a consent
  // ledger event needs to key against in the first place.
  if (earlyDanger.urgencyLevel !== 'critical') {
    const consentState = await loadConsentState(from);
    if (needsConsent(consentState)) {
      if (channel === 'web') {
        let webResponse = t(lang, 'web_consent_required');
        if (earlyDanger.urgencyLevel === 'high' || earlyDanger.urgencyLevel === 'moderate') {
          webResponse = `${dangerCopy(earlyDanger.urgencyLevel, lang)}\n\n${webResponse}`;
        }
        await auditDangerEscalation(from, earlyDanger.urgencyLevel);
        return {
          response: webResponse,
          urgencyLevel: earlyDanger.urgencyLevel,
          context: 'consent_required',
          consentRequired: true,
        };
      }

      // WhatsApp: stateless consent gate (see handleConsentGate above).
      const gate = await handleConsentGate(message, from, lang);
      if (!gate.granted) {
        let gateResponse = gate.response;
        if (earlyDanger.urgencyLevel === 'high' || earlyDanger.urgencyLevel === 'moderate') {
          gateResponse = `${dangerCopy(earlyDanger.urgencyLevel, lang)}\n\n${gateResponse}`;
        }
        await auditDangerEscalation(from, earlyDanger.urgencyLevel);
        // Persisted here — unlike the web consentRequired path above —
        // because handleConsentGate's own "was the last bot message the
        // consent prompt?" detection (mirroring handleOnboarding's
        // NAME_PROMPT_MARKERS pattern) depends on conversations being
        // saved; without this the gate could never see its own prior
        // prompt and would re-ask forever, never recognizing "I AGREE".
        // This is the same storage un-onboarded users already relied on
        // before P3-B existed. The web channel has no such dependency —
        // its consentRequired check re-derives fresh from the consent
        // ledger on every request — so it can skip storage entirely.
        const sx = extractSymptoms(message);
        if (sx.length > 0) {
          await db.saveSymptoms(from, sx, assessMood(message), earlyDanger.urgencyLevel);
        }
        await db.saveConversation(from, message, gateResponse, {
          dangerSigns: earlyDanger.detectedSigns || [],
          urgencyLevel: earlyDanger.urgencyLevel,
          context: 'consent_gate',
          channel,
        });
        return withActionButtons({ response: gateResponse, urgencyLevel: earlyDanger.urgencyLevel, context: 'consent_gate' });
      }
      // Granted this turn: fall through into the normal routing below
      // (onboarding is still needed — consent and profile are separate
      // concerns) with a short confirmation prefixed onto whatever
      // that routing produces. Held separately from `response` (rather
      // than assigned into it directly) because every branch further
      // down — onboarding, journaling, danger, AI — does a plain
      // `response = ...` assignment, not an append; see where
      // consentGrantedPrefix is applied below.
      consentGrantedPrefix = `${gate.response}\n\n`;
    }
  }

  // Onboarding takes precedence over every command except CRITICAL
  // danger signs (per spec §7.4). Otherwise un-onboarded users could
  // type `journal` (or paste anything) and bypass the profile capture
  // entirely, leaving downstream features without context.
  if (earlyDanger.urgencyLevel !== 'critical' && userContext.needsOnboarding) {
    conversationContext = 'onboarding';
    const onboardingTurn = await handleOnboarding(user, message, from, lang, {
      canAi: canUseAi(await loadConsentState(from)),
    });
    response = consentGrantedPrefix + onboardingTurn.response;
    aiUsed = onboardingTurn.aiUsed;
    let onboardingTriage = earlyDanger;
    if (canUseAi(await loadConsentState(from))) {
      const raised = await llmTriageRaise(message, earlyDanger.urgencyLevel, user.pregnancy_week, from);
      if (raised) {
        onboardingTriage = raised;
        await auditDangerEscalation(from, raised.urgencyLevel, { source: 'llm_raise' });
      }
    }
    if (
      onboardingTriage.urgencyLevel === 'high' ||
      onboardingTriage.urgencyLevel === 'moderate'
    ) {
      response = `${dangerCopy(onboardingTriage.urgencyLevel, lang)}\n\n${response}`;
    }
    const sx = extractSymptoms(message);
    if (sx.length > 0) {
      await db.saveSymptoms(from, sx, assessMood(message), earlyDanger.urgencyLevel);
    }
    await db.saveConversation(from, message, response, {
      dangerSigns: onboardingTriage.detectedSigns || [],
      urgencyLevel: onboardingTriage.urgencyLevel,
      context: conversationContext,
      channel,
    });
    return withActionButtons({ response, urgencyLevel: onboardingTriage.urgencyLevel, context: conversationContext, aiUsed });
  }

  // --- Journal session + commands ------------------------------------
  // Commands match the WHOLE message (core parseCommand), never a
  // substring. An open journal session only captures the next message
  // when it is (a) on this same channel, (b) not stale, and (c) the
  // message isn't a CRITICAL/HIGH danger sign or a cancel — the 2026-10
  // simulation found mothers trapped for months in "rate your mood
  // 1-10" while reporting bleeding and fevers.
  // --- Conversational profile updates ----------------------------------
  // "my name is…", "I'm 28 weeks", "Kiswahili tafadhali", "nimejifungua".
  // Deterministic and confirmed back to her; the AI is told it cannot
  // change anything itself (it used to claim "I've updated that").
  let handled = false;
  let profileNote = '';
  const profileUpdate = earlyDanger.urgencyLevel === 'low' || earlyDanger.urgencyLevel === 'moderate'
    ? parseProfileUpdate(message)
    : null;
  // Only a message the rules call low may end here. With any symptom in
  // it, the update is still applied but the turn goes on to normal
  // routing (AI reply + raise-only triage), with the confirmation on top.
  const quietTurn = earlyDanger.urgencyLevel === 'low';
  if (profileUpdate?.kind === 'language') {
    if (profileUpdate.lang !== lang) {
      await userManager.updateUserProfile(from, { language: profileUpdate.lang });
      user.language = profileUpdate.lang;
      lang = profileUpdate.lang;
    }
    if (profileUpdate.whole && quietTurn) {
      response = t(lang, lang === 'sw' ? 'lang_set_sw' : 'lang_set_en');
      handled = true;
    }
  } else if (profileUpdate?.kind === 'name') {
    await userManager.updateUserProfile(from, { name: profileUpdate.name });
    user.name = profileUpdate.name;
    if (quietTurn) {
      response = t(lang, 'profile_name_updated', { name: profileUpdate.name });
      handled = true;
    } else {
      profileNote = t(lang, 'profile_name_updated', { name: profileUpdate.name });
    }
  } else if (profileUpdate?.kind === 'week') {
    const edd = calculateEDDFromWeeks(profileUpdate.weeks);
    await userManager.updateUserProfile(from, { pregnancy_week: profileUpdate.weeks, edd });
    user.pregnancy_week = profileUpdate.weeks;
    user.edd = edd;
    if (quietTurn) {
      response = t(lang, 'profile_week_updated', { weeks: profileUpdate.weeks });
      handled = true;
    } else {
      profileNote = t(lang, 'profile_week_updated', { weeks: profileUpdate.weeks });
    }
  } else if (profileUpdate?.kind === 'birth' && !user.delivery_date) {
    const status = pregnancyStatus(user, new Date());
    // A birth before ~22 weeks isn't a "baby arrived" update this flow
    // should make on its own; leave that to the AI and a health worker.
    if (status.phase === 'pregnant' && status.week >= 22) {
      const deliveryDate = await birthDateFrom(message, canUseAi(await loadConsentState(from)));
      await userManager.updateUserProfile(from, { delivery_date: deliveryDate });
      user.delivery_date = deliveryDate;
      if (profileUpdate.whole && quietTurn) {
        response = t(lang, 'delivery_congrats');
        handled = true;
      } else {
        profileNote = t(lang, 'delivery_congrats');
      }
    }
  }
  if (handled) conversationContext = 'profile_update';

  let command = handled ? null : parseCommand(message);
  // "Turn on AI replies" (the button on the AI-off reply): an explicit tap
  // that grants the optional ai_responses consent, recorded like I AGREE.
  // The message she sent while AI was off is then answered.
  let aiInput = message;
  if (command === 'ai_on') {
    command = null;
    if (canUseAi(await loadConsentState(from))) {
      response = t(lang, 'ai_already_on');
      conversationContext = 'profile_update';
      handled = true;
    } else {
      await db.recordConsent(from, 'ai_responses', true, CONSENT_VERSION);
      await recordAuditSafe({
        actor: from,
        action: 'consent_grant',
        resource: 'consent',
        resourceOwner: from,
        metadata: { purpose: 'ai_responses', granted: true, channel, via: 'chat_button' },
      });
      const lastBot = await db.getLastBotMessage(from);
      if (lastBot?.message && AI_OFF_MARKERS.some((m) => lastBot.response.includes(m))) {
        aiInput = lastBot.message;
        profileNote = t(lang, 'ai_on_thanks');
      } else {
        response = t(lang, 'ai_on_ask');
        conversationContext = 'profile_update';
        handled = true;
      }
    }
  }
  if (!command && !handled && earlyDanger.urgencyLevel === 'low' && isGoAhead(message)) {
    // "Prompt me" / "let's go" right after Amaaii offered the check-in.
    const lastBot = await db.getLastBotMessage(from);
    const offered = lastBot?.response ? offeredActions(lastBot.response) : [];
    if (offered.includes('resume')) command = 'resume';
    else if (offered.includes('start_journal')) command = 'journal';
  }
  let journalNote = '';
  let replyOptions: string[] | null = null;
  // She chose "I feel unwell"/"Pain N/10" in the check-in: always triage.
  let forceTriage = false;
  const now = new Date();
  let journalSession = handled ? null : await journalManager.getJournalSession(from);
  if (journalSession && !journalManager.isResumable(journalSession, now)) {
    // An earlier day's unfinished check-in: its answers stay as an
    // incomplete entry, and today starts fresh.
    await journalManager.cancelJournal(from);
    journalSession = null;
  }
  // The check-in takes this message as an answer only while she is
  // answering it: on its own channel, not paused, not left for hours.
  // Otherwise it waits, paused, for her to tap Resume.
  if (
    journalSession && !journalSession.paused &&
    (journalSession.channel !== channel || isJournalSessionStale(journalSession.updatedAt, now))
  ) {
    await journalManager.pauseJournal(from);
    journalSession.paused = true;
  }
  const answering = !!journalSession && !journalSession.paused;

  if (aiInput !== message) {
    // The "Turn on AI replies" tap: her earlier message is answered below;
    // a check-in waits, paused.
    if (answering) await journalManager.pauseJournal(from);
  } else if (answering && (earlyDanger.urgencyLevel === 'critical' || earlyDanger.urgencyLevel === 'high')) {
    // Care first: the check-in waits, paused.
    await journalManager.interruptForDanger(from, message, earlyDanger);
    journalNote = t(lang, 'journal_pause');
  } else if (journalSession && command === 'cancel') {
    await journalManager.cancelJournal(from);
    response = t(lang, 'journal_cancelled');
    conversationContext = 'journaling';
    handled = true;
  } else if (journalSession && (command === 'resume' || (answering && command === 'journal'))) {
    response = await journalManager.resumeJournal(from, channel);
    conversationContext = 'journaling';
    handled = true;
  } else if (journalSession && command === 'journal') {
    // "Start journal" with one paused: carry on, or start over?
    response = journalManager.pausedCard(journalSession, lang, 'journal_pending_card');
    conversationContext = 'journaling';
    handled = true;
  } else if (answering && command && command !== 'restart') {
    // Asked for a summary/report/help mid-check-in: answer it; the
    // check-in waits, paused.
    await journalManager.pauseJournal(from);
  } else if (answering || command === 'journal' || command === 'resume' || command === 'restart') {
    let session = answering ? journalSession! : null;
    if (command === 'restart' && journalSession) {
      await journalManager.restartJournal(from, channel);
      session = await journalManager.getJournalSession(from);
    }
    session = session ?? await journalManager.startJournalSession(from, user, channel);
    // processJournalResponse only returns the {error} shape when there
    // is no active session in the DB — we just created/fetched one.
    const journalAi = canUseAi(await loadConsentState(from));
    const result = await journalManager.processJournalResponse(from, message, session.currentStage, { canAi: journalAi }) as {
      response: string;
      passThrough?: boolean;
      unwell?: boolean;
      options?: string[];
      mentionsSymptom?: boolean;
    };
    if (result.unwell && !journalAi) {
      // No model to talk it through: point her to care in plain words.
      response = t(lang, 'journal_unwell_no_ai');
      conversationContext = 'journaling';
      handled = true;
    } else if (result.passThrough) {
      // Paused by the journal manager; routed below, with the paused card.
      forceTriage = !!result.unwell;
    } else {
      response = result.response;
      conversationContext = 'journaling';
      handled = true;
      if (result.options?.length) replyOptions = result.options;
      // A free-text journal answer the rules missed may still be an
      // emergency ("baby has been quiet all day"): second opinion, raise-only.
      // A score answer ("It was a 7") only when it also mentions a symptom;
      // the deterministic rules above still see every word either way.
      if (journalAi && (!JOURNAL_SCORE_STAGES.has(session.currentStage) || result.mentionsSymptom)) {
        const raised = await llmTriageRaise(message, earlyDanger.urgencyLevel, user.pregnancy_week, from);
        if (raised) {
          await journalManager.interruptForDanger(from, message, raised);
          dangerSignAnalysis = raised;
          response = `${dangerCopy(raised.urgencyLevel, lang)}\n\n${t(lang, 'journal_pause')}`;
          conversationContext = 'danger_sign_detected';
          replyOptions = null;
          await auditDangerEscalation(from, raised.urgencyLevel, { source: 'llm_raise' });
        }
      }
    }
  }
  // A check-in waiting for her to tap Resume (shown on the reply below).
  const openCheckin = await journalManager.getJournalSession(from);
  const pausedCheckin = openCheckin?.paused ? openCheckin : null;

  if (handled) {
    // Journal turn (or cancel) — nothing more to route.
  } else if (command === 'help') {
    // The copy has always said 'Type "help"' — now there is a help.
    response = t(lang, 'help_menu') + appLine(lang);
    conversationContext = 'help';
  } else if (command === 'summary' || command === 'weekly_summary') {
    if (command === 'weekly_summary') {
      response = await journalManager.getWeeklySummary(from);
    } else {
      const todaysJournal = await db.getTodaysJournal(from);
      if (todaysJournal) {
        // JournalRow (a concrete DB row shape) vs. JournalSummaryData
        // (a loosely-typed bag with a catch-all index signature) are
        // structurally compatible in practice but TS's assignability
        // rules don't bridge "no index signature" -> "has one" for two
        // separately-declared interfaces without a cast.
        response = await journalManager.generateJournalSummary(todaysJournal as typeof todaysJournal & Record<string, unknown>, {}, lang);
      } else {
        response = t(lang, 'journal_none_today');
      }
    }
    conversationContext = 'journal_summary';
  } else if (command === 'doctor_report') {
    response = await journalManager.generateDoctorReport(from, 30);
    conversationContext = 'doctor_report';
  } else {
    dangerSignAnalysis = earlyDanger;
    const mood = assessMood(message);
    const symptoms = extractSymptoms(message);
    const conversationHistory = await db.getConversationHistory(from, 20);

    log.info('Analysis', { urgencyLevel: dangerSignAnalysis.urgencyLevel, mood, symptoms });

    // Routing precedence (per spec §7.4): CRITICAL short-circuits;
    // un-onboarded users were already routed above; HIGH escalates;
    // everything else goes to the AI.
    if (dangerSignAnalysis.urgencyLevel === 'critical' || dangerSignAnalysis.urgencyLevel === 'high') {
      const level = dangerSignAnalysis.urgencyLevel;
      // Full copy the first time; a shorter "have you reached care?"
      // version for a repeat inside the same episode. Urgency, audit and
      // follow-up are identical either way.
      response = escalationVariant(level, conversationHistory, new Date()) === 'repeat'
        ? dangerRepeatCopy(level, lang)
        : dangerCopy(level, lang);
      if (journalNote) response += `\n\n${journalNote}`;
      if (profileNote) response += `\n\n${profileNote}`;
      conversationContext = 'danger_sign_detected';
      if (symptoms.length > 0) {
        await db.saveSymptoms(from, symptoms, mood, level);
      }
      await auditDangerEscalation(from, level);
    } else {
      if (checkIfMentalHealth(message)) {
        conversationContext = 'mental_health';
      }

      const trend = await getRecentTrend(from, 7);
      const trendLine = trendForPrompt(trend);
      const mh = await db.getMedicalHistory(from).catch(() => null);

      // P3-B: the AI/consent gate. data_processing is already guaranteed
      // active by this point (the consent-gate block above returned
      // early otherwise) — this only checks the OPTIONAL ai_responses
      // purpose. When it's not active, the LLM chokepoint
      // (getAmaaiiResponse -> @amaaii/adapters#chat ->
      // openai.chat.completions.create) is simply never called; the
      // canned ai_off_reply takes its place. Journaling/danger detection
      // above this branch are entirely unaffected either way.
      const aiConsentState = await loadConsentState(from);
      const status = pregnancyStatus(user, new Date());
      if (canUseAi(aiConsentState)) {
        const raisePromise = llmTriageRaise(aiInput, dangerSignAnalysis.urgencyLevel, user.pregnancy_week, from, { force: forceTriage });
        response = await getAmaaiiResponse(aiInput, {
          userName: user.name,
          pregnancyWeek: status.phase === 'pregnant' ? status.week : null,
          postpartumDays: status.phase === 'postpartum' ? status.days : null,
          location: user.location,
          isNewUser: userContext.isNewUser,
          conversationHistory,
          currentContext: conversationContext,
          language: lang,
          trendLine,
          medicalHistory: mh,
          appUrl: publicBaseUrl(),
          channel,
          pausedCheckinNext: pausedCheckin ? checkinStageLabel(pausedCheckin.currentStage, 'en') : null,
        });
        aiUsed = true;
        captureMedicalHistory(from, aiInput);
        const raised = await raisePromise;
        if (raised) {
          dangerSignAnalysis = {
            ...raised,
            detectedSigns: [...dangerSignAnalysis.detectedSigns, ...raised.detectedSigns],
          };
          if (!advisesCareNow(response)) {
            const copy = escalationVariant(raised.urgencyLevel, conversationHistory, new Date()) === 'repeat'
              ? dangerRepeatCopy(raised.urgencyLevel, lang)
              : dangerCopy(raised.urgencyLevel, lang);
            response = `${copy}\n\n${response}`;
          }
          await auditDangerEscalation(from, raised.urgencyLevel, { source: 'llm_raise' });
        }
      } else {
        response = t(lang, 'ai_off_reply');
      }

      if (symptoms.length > 0) {
        await db.saveSymptoms(from, symptoms, mood, dangerSignAnalysis.urgencyLevel);
      }

      // She asked about the check-in ("How do I start a journal?"): give
      // her the button, whatever the model wrote.
      if (JOURNAL_WORDS.test(message) && !offersJournal(response) && !pausedCheckin) {
        response += `\n\n${t(lang, 'journal_start_hint')}`;
      }
      if (profileNote) response = `${profileNote}\n\n${response}`;
      // Due date passed with no birth recorded: ask once.
      const askedDelivery = conversationHistory.some((turn) =>
        !!turn.response && DELIVERY_ASK_MARKERS.some((m) => turn.response!.includes(m))
      );
      if (status.phase === 'pregnant' && status.overdue && !askedDelivery) {
        response += `\n\n${t(lang, 'delivery_ask')}`;
      }
      if (journalNote) {
        response += `\n\n${journalNote}`;
      } else {
        // Deterministic journal reminder (D19): append iff user hasn't
        // journaled today AND no recent bot turn already nudged them
        // (in either language).
        const todaysJournal = await db.getTodaysJournal(from);
        if (!todaysJournal && !offersJournal(response) && !pausedCheckin) {
          const remindedRecently = (conversationHistory || []).some((turn) => {
            const resp = turn.response;
            return !!resp && JOURNAL_REMINDER_MARKERS.some((m) => resp.includes(m));
          });
          if (!remindedRecently) {
            response += `\n\n${t(lang, 'journal_reminder')}`;
          }
        }
      }
    }
  }

  // Applied here (rather than at the point consent was granted) because
  // every branch between here and there does a plain `response = ...`
  // assignment — see the consent-gate block's comment. A no-op
  // (`consentGrantedPrefix` stays '') for every turn that didn't just
  // grant consent, which is the overwhelming majority of turns.
  // A paused check-in is always in view: what's saved, what's next, and
  // Resume / Restart / Stop. Not on a danger reply (care comes first) or on
  // a turn that was itself about the check-in.
  const finalUrgency = (dangerSignAnalysis ?? earlyDanger).urgencyLevel;
  if (pausedCheckin && conversationContext !== 'journaling' && finalUrgency !== 'critical' && finalUrgency !== 'high') {
    response += `\n\n${journalManager.pausedCard(pausedCheckin, lang)}`;
  }

  response = consentGrantedPrefix + response;

  // Every context — journal turns included — records the message's real
  // deterministic urgency. (Journal turns used to be forced to 'low',
  // which silently skipped the follow-up job and the audit row.)
  const triage = dangerSignAnalysis ?? earlyDanger;
  const analysisData = {
    dangerSigns: triage.detectedSigns || [],
    urgencyLevel: triage.urgencyLevel || 'low',
    context: conversationContext,
    channel,
  };

  const buttons = replyOptions ? { body: response, options: replyOptions } : undefined;
  if (buttons) response = withOptionList(buttons.body, buttons.options, lang);

  await db.saveConversation(from, message, response, analysisData);

  return withActionButtons({
    response,
    urgencyLevel: analysisData.urgencyLevel,
    context: conversationContext,
    aiUsed,
    ...(buttons ? { buttons } : {}),
  });
}

// --- Check-in follow-up job (P4-A) --------------------------------------
// Migrated off the in-process `setTimeout(..., 3600000)` this file used
// to run directly (see CLAUDE.md's Architecture section, which
// documented that as deferred future work) onto the durable SQLite job
// queue (apps/server/src/database.ts's enqueueJob, apps/server/src/
// jobWorker.ts's poller). Message content, recipient, and the
// 1-hour delay are all UNCHANGED from the old setTimeout — only the
// delivery mechanism moved, so a follow-up scheduled before a server
// restart still fires afterward (the whole point of this migration; see
// the P4-A work order's restart-durability requirement).

export const CHECKIN_FOLLOWUP_JOB_TYPE = 'checkin_followup';

/** Verbatim copy of the message the old setTimeout sent — do not reword
 *  without also checking any test/fixture that asserts on this exact
 *  string. */
export const CHECKIN_FOLLOWUP_MESSAGE =
  "Hi! I wanted to check in - were you able to see a healthcare provider? How are you feeling now? 💚";

export interface CheckinFollowupPayload {
  phone: string;
}

/**
 * Job handler for CHECKIN_FOLLOWUP_JOB_TYPE (registered against the
 * worker in apps/server/src/index.ts). Sends the SAME follow-up message
 * the old setTimeout sent, then logs it into the conversation history
 * with the same 'follow_up' context/urgency shape.
 *
 * IDEMPOTENCY: at-least-once, by design, not exactly-once. A crash
 * between sendWhatsAppMessage succeeding and markDone() persisting would
 * cause the worker to retry this job (per the normal
 * markFailedOrRetry/reclaimStuck paths) and could send a second,
 * duplicate follow-up on the same phone. This is an accepted, documented
 * trade-off rather than an oversight: the cost of an occasional
 * duplicate "how are you feeling" nudge is low, while building true
 * exactly-once delivery (e.g. a send-outbox row checked/written in the
 * same transaction as the status flip) is disproportionate effort for a
 * single low-stakes reminder message. In the overwhelmingly common case
 * — no crash mid-send — this sends exactly once, identical to the old
 * setTimeout's behavior.
 */
export async function sendCheckinFollowup(payload: CheckinFollowupPayload): Promise<void> {
  const { phone } = payload;
  // Her language; the English text is CHECKIN_FOLLOWUP_MESSAGE verbatim.
  const user = await db.getUser(phone).catch(() => undefined);
  const message = pickLang(user?.language) === 'sw' ? t('sw', 'checkin_followup') : CHECKIN_FOLLOWUP_MESSAGE;
  await sendWhatsAppMessage(phone, message);
  await db.saveConversation(phone, '[System Follow-up]', message, {
    context: 'follow_up',
    dangerSigns: [],
    urgencyLevel: 'low',
  });
}

const CHECKIN_FOLLOWUP_DELAY_MS = 3600000; // 1 hour — unchanged from the old setTimeout.

/**
 * Enqueue the 1-hour "were you able to see someone?" follow-up for a
 * high/critical turn. Shared by the WhatsApp entry point and (since
 * 2026-10) POST /chat, so an escalation in the app gets the same nudge on
 * WhatsApp. Never throws — a missed nudge must not break the reply.
 */
export async function scheduleEscalationFollowup(from: string, urgencyLevel: string): Promise<void> {
  if (urgencyLevel !== 'high' && urgencyLevel !== 'critical') return;
  const now = new Date();
  const runAt = new Date(now.getTime() + CHECKIN_FOLLOWUP_DELAY_MS).toISOString();
  // Dedupe key buckets by wall-clock hour: if the same user sends
  // several HIGH/CRITICAL messages within one hour, only the FIRST
  // schedules a follow-up. Without this, an anxious user re-tripping
  // danger signs repeatedly would pile up several duplicate "how are
  // you feeling" nudges an hour later.
  const hourBucket = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const dedupeKey = `${CHECKIN_FOLLOWUP_JOB_TYPE}:${from}:${hourBucket}`;
  try {
    await db.enqueueJob({
      type: CHECKIN_FOLLOWUP_JOB_TYPE,
      payload: { phone: from },
      runAt,
      dedupeKey,
    });
  } catch (err) {
    log.error('Failed to enqueue checkin_followup job', err);
  }
}

/**
 * A voice note, photo or other non-text message. Transport-neutral (the
 * Twilio webhook and the Meta webhook both call it): reply in her
 * language with the "please type" copy, which deliberately keeps the
 * go-to-a-facility danger line — a voice note might be an emergency.
 */
export async function handleUnsupportedMedia(from: string): Promise<void> {
  const user = await db.getUser(from).catch(() => undefined);
  const reply = t(user?.language, 'unsupported_message_type');
  await sendWhatsAppMessage(from, reply);
  if (user) {
    await db.saveConversation(from, '[media]', reply, { context: 'unsupported_media', urgencyLevel: 'low', dangerSigns: [], channel: 'whatsapp' })
      .catch((err) => log.warn('Could not log unsupported media turn', { error: err instanceof Error ? err.message : String(err) }));
  }
}

// Twilio WhatsApp transport: process + send + schedule follow-up.
export async function handleIncomingMessage(
  from: string,
  message: string,
  profileName: string | null
): Promise<void> {
  try {
    // An empty body (a media message on any path) must never reach the
    // brain — the AI would answer a question nobody asked.
    if (!String(message ?? '').trim()) {
      await handleUnsupportedMedia(from);
      return;
    }
    const { response, urgencyLevel, buttons } = await processMessage(from, message, profileName);

    if (buttons) {
      await sendWhatsAppButtons(from, buttons.body, buttons.options, buttons.fallback ?? response);
    } else {
      await sendWhatsAppMessage(from, response);
    }
    log.info(`Response sent successfully to ${from}`);

    // Durable follow-up for high-risk cases (P4-A — see the job/handler
    // pair above; this used to be an in-process setTimeout).
    await scheduleEscalationFollowup(from, urgencyLevel);
  } catch (error) {
    log.error('Error in message handler', error);
    try {
      // The user lookup may be what failed, so English is the fallback.
      const failedUser = await db.getUser(from).catch(() => undefined);
      await sendWhatsAppMessage(from, t(pickLang(failedUser?.language), 'error_generic'));
    } catch (sendError) {
      log.error('Failed to send error message', sendError);
    }
  }
}

// Marker phrases used to detect that the bot's most recent outbound asked
// for a given field — both languages, because the language can change
// between turns. Onboarding stays stateless: the next question is the
// first missing field, and these markers tell us whether we just asked it.
const NAME_PROMPT_MARKERS = [
  "What's your name?", // EN
  "Jina lako ni nani?", // SW
  "What should I call you?", // name_prompt_retry
  "Nikuite nani?",
];
const LOCATION_PROMPT_MARKERS = ['Where are you located', 'Which town or area', 'Uko wapi', 'Unaishi mji'];
const AGE_PROMPT_MARKERS = ['tell me your age', 'How old are you', 'una umri gani', 'Una miaka mingapi'];
const WEEK_PROMPT_MARKERS = ['How far along', "I didn't catch that", 'Mimba yako ina muda gani', 'Sikuelewa — hakuna shida'];

type OnboardingSlot = 'name' | 'age' | 'week' | 'location';

function missingSlots(u: Partial<UserWithFlag>): OnboardingSlot[] {
  const out: OnboardingSlot[] = [];
  if (!u.name) out.push('name');
  if (!u.age) out.push('age');
  if (u.pregnancy_week == null && !u.delivery_date) out.push('week');
  if (!u.location && !u.location_declined) out.push('location');
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

function validName(raw: string | undefined): string | null {
  if (!raw) return null;
  const name = cleanName(raw);
  if (!name || name.length > 40 || !/[a-zA-Z]/.test(name) || name.split(/\s+/).length > 4) return null;
  if (/\b(?:pregnant|fine|okay|ok|hello|hi|agree|yes|no|mimba|sawa)\b/i.test(name)) return null;
  return name;
}

// A reply made only of these words is not a place. A prod mother answered
// "Confirm" to the location question and it was saved as her location.
const NON_PLACE_WORDS = new Set([
  'confirm', 'confirmed', 'ok', 'okay', 'k', 'yes', 'yeah', 'yep', 'no', 'nope', 'sure', 'done', 'fine',
  'agree', 'i', 'thanks', 'thank', 'you', 'hello', 'hi', 'hey', 'next', 'continue', 'skip', 'stop', 'help',
  'none', 'nothing', 'later', 'please', 'sawa', 'ndiyo', 'ndio', 'hapana', 'nakubali', 'asante', 'habari',
  'sijui', 'poa', 'tafadhali', 'endelea',
]);

function validLocation(raw: string | undefined): string | null {
  if (!raw || isLocationRefusal(raw)) return null;
  const loc = raw
    .replace(/\p{Extended_Pictographic}/gu, '')
    .trim()
    .replace(/^(?:i\s+(?:live|stay)\s+(?:in|at)|i'?m\s+(?:in|from|at)|from|in|at|niko|naishi|ninaishi|nakaa|kutoka)\s+/i, '')
    .replace(/[.!]+$/, '')
    .trim();
  if (!loc || loc.length > 60 || loc.includes('?') || loc.split(/\s+/).length > 6 || !/[a-zA-Z]/.test(loc)) return null;
  if (detectDangerSigns(loc).urgencyLevel !== 'low') return null;
  if (loc.toLowerCase().split(/[^a-z']+/).filter(Boolean).every((w) => NON_PLACE_WORDS.has(w))) return null;
  return loc;
}

// Plain-code validation of a slot the LLM proposed. The model only ever
// proposes; nothing it says is saved without passing these checks.
function slotsFromLlm(
  out: llm.OnboardingSlots,
  missing: OnboardingSlot[],
  current: OnboardingSlot,
  message: string,
  now: Date
): UpdateUserInput {
  const update: UpdateUserInput = {};
  if (missing.includes('name') && (current === 'name' || /\b(?:my name is|i'?m called|naitwa|ninaitwa|jina langu|call me|this is|ni mimi)\b/i.test(message))) {
    const name = validName(out.name);
    if (name) update.name = name;
  }
  if (missing.includes('age') && out.age != null && out.age >= 12 && out.age <= 55
      && (current === 'age' || /\b(?:years?|yrs?|miaka|age|aged|umri|y\/o|yo)\b/i.test(message))) {
    update.age = out.age;
  }
  if (missing.includes('week')) {
    if (out.babyBorn) {
      let delivery: string | null = null;
      if (out.deliveryDate) {
        const days = Math.floor((now.getTime() - Date.parse(`${out.deliveryDate}T00:00:00Z`)) / DAY_MS);
        if (days >= 0 && days <= 365) delivery = out.deliveryDate;
      } else if (out.babyAgeDays != null && out.babyAgeDays >= 0 && out.babyAgeDays <= 365) {
        delivery = isoDay(new Date(now.getTime() - out.babyAgeDays * DAY_MS));
      }
      update.delivery_date = delivery ?? isoDay(now);
    } else {
      let weeks: number | null = null;
      let lmp: string | undefined;
      let edd: string | undefined;
      if (out.weeks != null) weeks = out.weeks;
      else if (out.months != null && out.months > 0 && out.months <= 10) weeks = Math.round(out.months * 4.33);
      else if (out.lmp) {
        const days = Math.floor((now.getTime() - Date.parse(`${out.lmp}T00:00:00Z`)) / DAY_MS);
        if (days >= 0 && days <= 300) {
          lmp = out.lmp;
          weeks = Math.floor(days / 7);
        }
      } else if (out.edd) {
        const toEdd = Math.floor((Date.parse(`${out.edd}T00:00:00Z`) - now.getTime()) / DAY_MS);
        if (toEdd >= -14 && toEdd <= 280) {
          edd = out.edd;
          weeks = Math.max(0, Math.floor((280 - toEdd) / 7));
        }
      }
      if (weeks != null && weeks >= 0 && weeks <= 42) {
        update.pregnancy_week = weeks;
        update.edd = edd ?? (lmp ? userManager.calculateEDD(lmp) : calculateEDDFromWeeks(weeks));
        if (lmp) update.lmp = lmp;
      }
    }
  }
  if (missing.includes('location') && (current === 'location' || /\b(?:live|stay|from|naishi|niko|nakaa|kutoka|located)\b/i.test(message))) {
    const loc = validLocation(out.location);
    if (loc) update.location = loc;
  }
  return update;
}

// The question to ask for `next`, given what we already know. `retry` is
// true when we just asked for that same field and couldn't read the answer;
// `weekJustSet` when this message gave the week or the birth, which the
// location question then thanks her for.
function onboardingPrompt(
  next: OnboardingSlot,
  u: Partial<UserWithFlag>,
  lang: string,
  retry: boolean,
  nameJustSet: boolean,
  weekJustSet: boolean
): string {
  switch (next) {
    case 'name':
      return retry ? t(lang, 'name_prompt_retry') : t(lang, 'name_prompt');
    case 'age':
      if (retry) return t(lang, 'age_prompt_retry');
      // A name we didn't ask for came from her WhatsApp profile — let her change it.
      return nameJustSet ? t(lang, 'name_thanks', { name: u.name ?? '' }) : t(lang, 'age_prompt_profile', { name: u.name ?? '' });
    case 'week':
      return retry ? t(lang, 'week_prompt_again') : t(lang, 'age_thanks');
    case 'location':
      // Coming back to a missing location later (a "Hello" days on) gets
      // the plain question, not "Great! You're at week 9" again.
      if (retry || !weekJustSet) return t(lang, 'location_prompt_again');
      if (u.delivery_date) return t(lang, 'postpartum_thanks');
      if (u.lmp && u.edd) return t(lang, 'week_lmp_thanks', { weeks: u.pregnancy_week ?? '', edd: u.edd });
      return t(lang, 'week_thanks', { weeks: u.pregnancy_week ?? '' });
  }
}

// LLM-first, still stateless onboarding (2026-10 simulation: "4 months"
// was stored as week 4, "nina miaka kumi na tisa" looped for months, age
// was read out of "250mg", and any next sentence became the location).
// 1. Deterministic fast path for the field we're on.
// 2. If that misses — or the message is long enough to carry several
//    facts — one LLM call proposes every missing field; plain code
//    validates each before anything is saved.
// 3. Save, RE-READ the user, then ask for the next missing field.
// 4. A question she asks along the way gets a short answer first.
async function handleOnboarding(
  user: UserWithFlag,
  message: string,
  phoneNumber: string,
  lang: string = 'en',
  opts: { canAi?: boolean } = {}
): Promise<{ response: string; aiUsed: boolean }> {
  const missing = missingSlots(user);
  if (missing.length === 0) return { response: t(lang, 'welcome_back', { name: user.name ?? '' }), aiUsed: false };
  const current = missing[0];
  const now = new Date();
  const lastResp = (await db.getLastBotMessage(phoneNumber))?.response || '';
  const askedName = NAME_PROMPT_MARKERS.some((m) => lastResp.includes(m));
  const askedLocation = LOCATION_PROMPT_MARKERS.some((m) => lastResp.includes(m));
  // The turn that grants consent ("I AGREE") carries no profile facts.
  const isConsentReply = classifyConsentReply(message) === 'grant';

  const update: UpdateUserInput = {};
  if (!isConsentReply) {
    if (current === 'name' && askedName) {
      const name = validName(message);
      if (name && message.trim().split(/\s+/).length <= 6) update.name = name;
    } else if (current === 'age') {
      const age = parseAge(message);
      if (age != null) update.age = age;
    } else if (current === 'week') {
      if (parseProfileUpdate(message)?.kind === 'birth' || BIRTH_CUE.test(message)) {
        // "Baby was born 2 weeks ago, 16th Feb" — that date is the birth,
        // not a last period (it used to be stored as pregnancy week 2).
        update.delivery_date = await birthDateFrom(message, !!opts.canAi);
      } else {
        const parsed = parseWeekOrLMP(message);
        if (parsed && parsed.weeks >= 0 && parsed.weeks <= 42) {
          update.pregnancy_week = parsed.weeks;
          update.edd = parsed.edd
            ?? (parsed.lmp ? userManager.calculateEDD(parsed.lmp) : calculateEDDFromWeeks(parsed.weeks));
          if (parsed.lmp) update.lmp = parsed.lmp;
        }
      }
    } else if (current === 'location' && askedLocation) {
      if (isLocationRefusal(message)) {
        update.location_declined = 1;
      } else {
        const loc = validLocation(message);
        if (loc) update.location = loc;
      }
    }

    const words = message.trim().split(/\s+/).filter(Boolean).length;
    const currentFilled = Object.keys(update).length > 0;
    // The model only sees her words with the optional ai_responses consent;
    // without it, onboarding runs on the deterministic parsers alone.
    if (opts.canAi && ((!currentFilled && words >= 1) || words >= 5)) {
      const out = await llm.extractOnboardingSlots(message, missing).catch(() => null);
      if (out) {
        const proposed = slotsFromLlm(out, missing, current, message, now);
        for (const [k, v] of Object.entries(proposed)) {
          if ((update as Record<string, unknown>)[k] === undefined) (update as Record<string, unknown>)[k] = v;
        }
      }
    }
    // A refusal is never overridden by a place the model read into it.
    if (update.location_declined) delete update.location;
    // A birth wins over any pregnancy week proposed alongside it.
    if (update.delivery_date) {
      delete update.pregnancy_week;
      delete update.edd;
      delete update.lmp;
    }
  }

  let fresh: Partial<UserWithFlag> = user;
  if (Object.keys(update).length > 0) {
    // UpdateUserInput (no index signature) vs. updateUserProfile's
    // Record<string, unknown> parameter — whitelist-filtered at runtime.
    fresh = (await userManager.updateUserProfile(phoneNumber, update as Record<string, unknown>)) ?? { ...user, ...update };
  }

  // A question she asked, or help she asked for, gets an answer first —
  // even when the same message also answered the field (the simulation's
  // mothers asked "is this a person or a bot?" three times while
  // onboarding carried on regardless; a prod mother asked for help with
  // symptoms twice and got the name and age questions back). "Why do you
  // need this?" has a fixed answer, AI or not.
  const declined = update.location_declined === 1;
  const join = (...parts: string[]): string => parts.filter(Boolean).join('\n\n');
  const answerFirst = async (prompt: string): Promise<{ response: string; aiUsed: boolean }> => {
    const declinedNote = declined ? t(lang, 'location_declined') : '';
    if (isConsentReply) return { response: prompt, aiUsed: false };
    if (isWhyAskQuestion(message)) return { response: join(t(lang, 'onboarding_why'), declinedNote, prompt), aiUsed: false };
    const wantsHelp = asksForHelp(message);
    if (!message.includes('?') && !wantsHelp) return { response: join(declinedNote, prompt), aiUsed: false };
    if (!opts.canAi) {
      return { response: join(wantsHelp ? t(lang, 'onboarding_help_no_ai') : '', declinedNote, prompt), aiUsed: false };
    }
    const answer = await getAmaaiiResponse(message, {
      userName: fresh.name,
      pregnancyWeek: fresh.pregnancy_week,
      location: fresh.location,
      currentContext: 'onboarding',
      language: lang,
    });
    return { response: join(answer, declinedNote, prompt), aiUsed: true };
  };

  const stillMissing = missingSlots(fresh);
  if (stillMissing.length === 0) {
    const summary = userManager.formatUserSummary(fresh);
    // Signed up in the app with AI replies left off: say so once, with the
    // button to turn them on.
    const aiHint = opts.canAi ? '' : `\n\n${t(lang, 'ai_off_hint')}`;
    return answerFirst(t(lang, 'location_done', { summary }) + appLine(lang) + aiHint);
  }
  const next = stillMissing[0];
  const askedCurrent = {
    name: askedName,
    age: AGE_PROMPT_MARKERS.some((m) => lastResp.includes(m)),
    week: WEEK_PROMPT_MARKERS.some((m) => lastResp.includes(m)),
    location: askedLocation,
  }[current];
  const retry = next === current && askedCurrent && Object.keys(update).length === 0;
  const weekJustSet = update.pregnancy_week !== undefined || update.delivery_date !== undefined;
  return answerFirst(onboardingPrompt(next, fresh, lang, retry, update.name !== undefined, weekJustSet));
}

function checkIfMentalHealth(message: string): boolean {
  const mentalHealthKeywords = [
    'sad', 'depressed', 'anxious', 'worried', 'scared', 'afraid',
    'crying', 'mood', 'emotional', 'stressed', 'overwhelmed',
    'panic', 'hopeless', 'alone', 'isolated',
  ];
  const lowerMessage = message.toLowerCase();
  return mentalHealthKeywords.some((keyword) => lowerMessage.includes(keyword));
}
