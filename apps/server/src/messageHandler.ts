// P1-E: ported 1:1 from utils/messageHandler.js (final step of the TS
// migration — see CLAUDE.md). Deterministic onboarding parsers
// (cleanName, parseWeekOrLMP, weeksFromLMP, inferLMPYear,
// calculateEDDFromWeeks) live in packages/core/src/onboarding.ts. The
// 3-strikes LLM fallback stays here, since it's orchestration (reads
// conversation history from the DB, calls ./llmExtract).

import { sendWhatsAppMessage } from '@amaaii/adapters';
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
  isJournalSessionStale,
  cleanName,
  parseWeekOrLMP,
  calculateEDDFromWeeks,
  CONSENT_VERSION,
  deriveConsentState,
  needsConsent,
  canUseAi,
  classifyConsentReply,
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
const JOURNAL_REMINDER_MARKERS = [
  t('en', 'journal_reminder'),
  t('sw', 'journal_reminder'),
];

// --- Consent gate (P3-B) -----------------------------------------------
// Fixed, var-free substrings of consent_request/consent_reprompt (both
// strings interpolate {url}, so the rendered text itself can't be used
// as a marker the way NAME_PROMPT_MARKERS reuses the full literal
// name_prompt string) — same "was the bot's last message asking X?"
// detection pattern as NAME_PROMPT_MARKERS / WEEK_REPROMPT_MARKERS
// above, kept stateless per CLAUDE.md's onboarding design.
const CONSENT_PROMPT_MARKERS = ['Reply *I AGREE* to continue', 'Jibu *NAKUBALI* kuendelea'];
// consent_explain reuses the reprompt phrase below; consent_declined reuses
// the prompt phrase above ("Reply *I AGREE* to continue").
const CONSENT_REPROMPT_MARKERS = ['please reply with the word *AGREE*', 'tafadhali jibu na neno *NAKUBALI*'];

// PUBLIC_BASE_URL is read at call time (not module load) so it can vary
// per-request in tests/dev without restarting the process. The /privacy
// page itself ships in P3-D — this only wires the mechanism (a 404 on
// that path today is expected and fine).
function privacyNoticeUrl(): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return 'the Amaaii app';
  return `${base.replace(/\/+$/, '')}/privacy`;
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
  pregnancyWeek: number | null | undefined
): Promise<DangerSignResult | null> {
  if (!llmTriageEnabled()) return null;
  if ((URGENCY_RANK[rulesUrgency] ?? 0) >= URGENCY_RANK.high) return null;
  // Greetings, numbers and one-word journal answers carry nothing to triage.
  if (message.trim().split(/\s+/).filter(Boolean).length < 4) return null;
  try {
    const out = await llm.assessUrgency(message, { pregnancyWeek });
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
    return { response: t(lang, 'consent_explain', { url: privacyNoticeUrl() }), granted: false };
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
  const lang = pickLang(user.language);

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
        });
        return { response: gateResponse, urgencyLevel: earlyDanger.urgencyLevel, context: 'consent_gate' };
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
    response = consentGrantedPrefix + await handleOnboarding(user, message, from, lang);
    let onboardingTriage = earlyDanger;
    if (canUseAi(await loadConsentState(from))) {
      const raised = await llmTriageRaise(message, earlyDanger.urgencyLevel, user.pregnancy_week);
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
    });
    return { response, urgencyLevel: onboardingTriage.urgencyLevel, context: conversationContext };
  }

  // --- Journal session + commands ------------------------------------
  // Commands match the WHOLE message (core parseCommand), never a
  // substring. An open journal session only captures the next message
  // when it is (a) on this same channel, (b) not stale, and (c) the
  // message isn't a CRITICAL/HIGH danger sign or a cancel — the 2026-10
  // simulation found mothers trapped for months in "rate your mood
  // 1-10" while reporting bleeding and fevers.
  const command = parseCommand(message);
  let journalNote = '';
  let handled = false;
  let journalSession = await journalManager.getJournalSession(from);
  if (journalSession && isJournalSessionStale(journalSession.updatedAt, new Date())) {
    await journalManager.cancelJournal(from);
    journalSession = null;
  }
  if (journalSession && journalSession.channel !== channel) {
    // Another channel's half-done check-in never swallows this message.
    // "journal" here takes the session over; anything else leaves it be.
    if (command === 'journal') await journalManager.cancelJournal(from);
    journalSession = null;
  }

  if (journalSession && (earlyDanger.urgencyLevel === 'critical' || earlyDanger.urgencyLevel === 'high')) {
    await journalManager.interruptForDanger(from, message, earlyDanger);
    journalNote = t(lang, 'journal_pause');
  } else if (journalSession && command === 'cancel') {
    await journalManager.cancelJournal(from);
    response = t(lang, 'journal_cancelled');
    conversationContext = 'journaling';
    handled = true;
  } else if (journalSession && command && command !== 'journal') {
    // Asked for a summary/report/help mid-check-in: close the check-in
    // and answer the command.
    await journalManager.cancelJournal(from);
  } else if (journalSession || command === 'journal') {
    const session = journalSession ?? await journalManager.startJournalSession(from, user, channel);
    // processJournalResponse only returns the {error} shape when there
    // is no active session in the DB — we just created/fetched one.
    const result = await journalManager.processJournalResponse(from, message, session.currentStage) as {
      response: string;
      passThrough?: boolean;
    };
    if (result.passThrough) {
      journalNote = t(lang, 'journal_paused_note');
    } else {
      response = result.response;
      conversationContext = 'journaling';
      handled = true;
      // A free-text journal answer the rules missed may still be an
      // emergency ("baby has been quiet all day"): second opinion, raise-only.
      if (canUseAi(await loadConsentState(from))) {
        const raised = await llmTriageRaise(message, earlyDanger.urgencyLevel, user.pregnancy_week);
        if (raised) {
          await journalManager.interruptForDanger(from, message, raised);
          dangerSignAnalysis = raised;
          response = `${dangerCopy(raised.urgencyLevel, lang)}\n\n${t(lang, 'journal_pause')}`;
          conversationContext = 'danger_sign_detected';
          await auditDangerEscalation(from, raised.urgencyLevel, { source: 'llm_raise' });
        }
      }
    }
  }

  if (handled) {
    // Journal turn (or cancel) — nothing more to route.
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
    const conversationHistory = await db.getConversationHistory(from, 5);

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
      if (canUseAi(aiConsentState)) {
        const raisePromise = llmTriageRaise(message, dangerSignAnalysis.urgencyLevel, user.pregnancy_week);
        response = await getAmaaiiResponse(message, {
          userName: user.name,
          pregnancyWeek: user.pregnancy_week,
          location: user.location,
          isNewUser: userContext.isNewUser,
          conversationHistory,
          currentContext: conversationContext,
          language: lang,
          trendLine,
          medicalHistory: mh,
        });
        aiUsed = true;
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

      if (journalNote) {
        response += `\n\n${journalNote}`;
      } else {
        // Deterministic journal reminder (D19): append iff user hasn't
        // journaled today AND no recent bot turn already nudged them
        // (in either language).
        const todaysJournal = await db.getTodaysJournal(from);
        if (!todaysJournal) {
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
  response = consentGrantedPrefix + response;

  // Every context — journal turns included — records the message's real
  // deterministic urgency. (Journal turns used to be forced to 'low',
  // which silently skipped the follow-up job and the audit row.)
  const triage = dangerSignAnalysis ?? earlyDanger;
  const analysisData = {
    dangerSigns: triage.detectedSigns || [],
    urgencyLevel: triage.urgencyLevel || 'low',
    context: conversationContext,
  };

  await db.saveConversation(from, message, response, analysisData);

  return {
    response,
    urgencyLevel: analysisData.urgencyLevel,
    context: conversationContext,
    aiUsed,
  };
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
  await sendWhatsAppMessage(phone, CHECKIN_FOLLOWUP_MESSAGE);
  await db.saveConversation(phone, '[System Follow-up]', CHECKIN_FOLLOWUP_MESSAGE, {
    context: 'follow_up',
    dangerSigns: [],
    urgencyLevel: 'low',
  });
}

const CHECKIN_FOLLOWUP_DELAY_MS = 3600000; // 1 hour — unchanged from the old setTimeout.

// Twilio WhatsApp transport: process + send + schedule follow-up.
export async function handleIncomingMessage(
  from: string,
  message: string,
  profileName: string | null
): Promise<void> {
  try {
    const { response, urgencyLevel } = await processMessage(from, message, profileName);

    await sendWhatsAppMessage(from, response);
    log.info(`Response sent successfully to ${from}`);

    // Durable follow-up for high-risk cases (P4-A — see the job/handler
    // pair above; this used to be an in-process setTimeout).
    if (urgencyLevel === 'high' || urgencyLevel === 'critical') {
      const now = new Date();
      const runAt = new Date(now.getTime() + CHECKIN_FOLLOWUP_DELAY_MS).toISOString();
      // Dedupe key buckets by wall-clock hour: if the same user sends
      // several HIGH/CRITICAL messages within one hour, only the FIRST
      // schedules a follow-up. Without this, an anxious user re-tripping
      // danger signs repeatedly would pile up several duplicate "how are
      // you feeling" nudges an hour later — the old setTimeout had no
      // such guard (every qualifying message scheduled its own timer);
      // this is a deliberate improvement made possible by having a real
      // queue to dedupe against, not a behavior preserved from before.
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
        // Never let a scheduling failure take down the primary reply
        // path — the user already has their immediate response; a
        // missed follow-up nudge is degraded service, not a broken
        // conversation.
        log.error('Failed to enqueue checkin_followup job', err);
      }
    }
  } catch (error) {
    log.error('Error in message handler', error);
    try {
      // We don't have user.language here (the lookup may be what failed),
      // so default to English. Real localized error UX is Phase 1.
      await sendWhatsAppMessage(from, t('en', 'error_generic'));
    } catch (sendError) {
      log.error('Failed to send error message', sendError);
    }
  }
}

// Marker phrases used to detect that the bot's most recent outbound was
// a name prompt — must check both languages because the user can switch
// language between turns. (Phase 0 stays stateless; the proper state
// machine is Phase 1.)
const NAME_PROMPT_MARKERS = [
  "What's your name?", // EN
  "Jina lako ni nani?", // SW
];

// Substrings that uniquely identify the week-stage re-prompt. Used to
// count consecutive failed attempts so we can escalate to the LLM
// fallback after the 3rd try.
const WEEK_REPROMPT_MARKERS = [
  "I didn't catch that", // EN re-prompt
  "Sikuelewa",           // SW re-prompt
];

// Liberal parser for the pregnancy-week answer, name cleaning, and the
// EDD-from-weeks calculation are all deterministic and now live in
// packages/core/src/onboarding.ts: parseWeekOrLMP, cleanName,
// calculateEDDFromWeeks (weeksFromLMP / inferLMPYear are internal
// helpers used by parseWeekOrLMP itself).
async function handleOnboarding(
  user: UserWithFlag,
  message: string,
  phoneNumber: string,
  lang: string = 'en'
): Promise<string> {
  if (!user.name) {
    const lastBot = await db.getLastBotMessage(phoneNumber);
    const previousWasNamePrompt =
      !!lastBot && !!lastBot.response &&
      NAME_PROMPT_MARKERS.some((m) => lastBot.response.includes(m));
    if (previousWasNamePrompt) {
      const cleaned = cleanName(message);
      // Sanity bounds — a reasonable name is 1-40 chars and has at least one letter.
      if (cleaned.length > 0 && cleaned.length <= 40 && /[a-zA-Z]/.test(cleaned)) {
        await userManager.updateUserProfile(phoneNumber, { name: cleaned });
        return t(lang, 'name_thanks', { name: cleaned });
      }
    }
    return t(lang, 'name_prompt');
  }

  if (!user.age) {
    const ageMatch = message.match(/\d+/);
    if (ageMatch) {
      const age = parseInt(ageMatch[0], 10);
      await userManager.updateUserProfile(user.phone_number, { age });
      return t(lang, 'age_thanks');
    }
    return t(lang, 'age_prompt_again', { name: user.name });
  }

  // `== null` rather than `!user.pregnancy_week`: week 0 is a VALID stored
  // value (an LMP within the last 6 days), and truthiness would treat it as
  // unset — re-asking this question forever and never reaching the location
  // step. Same reason for every other pregnancy_week check in this codebase.
  if (user.pregnancy_week == null) {
    let parsed = parseWeekOrLMP(message);

    // 3-strikes LLM fallback: if regex missed AND the bot has already
    // sent the re-prompt twice in the recent history, this is the
    // user's 3rd attempt — escalate to LLM extraction. Helps users
    // who phrase things in ways our regex doesn't cover ("5 months
    // along", "second trimester", "I'm not really sure but maybe...").
    if (!parsed) {
      const recent = await db.getConversationHistory(phoneNumber, 5);
      const reprompts = (recent || []).filter((turn) => {
        const resp = turn.response;
        return !!resp && WEEK_REPROMPT_MARKERS.some((m) => resp.includes(m));
      }).length;
      if (reprompts >= 2) {
        log.info('Onboarding week: 3-strikes LLM fallback triggered', { phoneNumber, reprompts });
        const out = await llm.extractWeekOrLMP(message).catch(() => null);
        if (out && (out.weeks || out.lmp)) {
          if (out.lmp) {
            const wk = userManager.calculatePregnancyWeek(out.lmp);
            if (wk !== null && wk >= 0 && wk <= 42) parsed = { weeks: wk, lmp: out.lmp };
          } else if (out.weeks != null) {
            parsed = { weeks: out.weeks };
          }
        }
      }
    }

    // `parsed.weeks != null` rather than truthiness — this is the exact line
    // that used to silently reject week 0: an LMP six days ago parses
    // correctly to {weeks: 0}, the falsy 0 short-circuited before the range
    // check, and the user got the generic "I didn't catch that" re-prompt
    // blaming their date FORMAT for something the parser had understood
    // perfectly. Observed in production onboarding.
    if (parsed && parsed.weeks != null && parsed.weeks >= 0 && parsed.weeks <= 42) {
      const edd = parsed.lmp
        ? userManager.calculateEDD(parsed.lmp)
        : calculateEDDFromWeeks(parsed.weeks);
      const update: UpdateUserInput = { pregnancy_week: parsed.weeks, edd };
      if (parsed.lmp) update.lmp = parsed.lmp;
      // UpdateUserInput (no index signature) vs. updateUserProfile's
      // Record<string, unknown> parameter (accepts arbitrary keys and
      // whitelist-filters them at runtime) — same "no index signature ->
      // has one" assignability gap as above.
      await userManager.updateUserProfile(user.phone_number, update as Record<string, unknown>);
      return parsed.lmp
        ? t(lang, 'week_lmp_thanks', { weeks: parsed.weeks, edd: edd ?? '' })
        : t(lang, 'week_thanks', { weeks: parsed.weeks });
    }
    return t(lang, 'week_prompt_again');
  }

  if (!user.location) {
    await userManager.updateUserProfile(user.phone_number, { location: message });
    const summary = userManager.formatUserSummary(user);
    return t(lang, 'location_done', { summary });
  }

  return t(lang, 'welcome_back', { name: user.name });
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
