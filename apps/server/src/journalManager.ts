// P1-E: ported 1:1 from services/journalManager.js (final step of the TS
// migration — see CLAUDE.md). Pure parsing (sleep/appetite/symptoms/
// mood), the stage-machine transition table, and summary/insight text
// formatting live in packages/core/src/journal.ts. This file keeps DB
// access, session persistence, and LLM-fallback orchestration — it's a
// consumer of core logic, not the source of truth for it.
//
// Uses `export =` (not `export default`) so a bare CommonJS `require()`
// — as used by tests/journalManager.test.js and tests/parsers.test.js —
// returns the singleton instance directly, exactly like the original
// `module.exports = new JournalManager();`.

import * as db from './database';
import * as llm from './llmExtract';
import { getRecentTrend } from './trend';
import {
  detectDangerSigns,
  t,
  pickLang,
  dangerCopy,
  nextJournalStage,
  extractNumber as coreExtractNumber,
  parseSymptomsAnswer,
  parseSleepAnswer,
  parseAppetiteAnswer,
  scanFreeText,
  parseCommand,
  looksLikeOffTopic,
  extractSymptoms,
  validJournalFields,
  buildClarifyOptions,
  bareSleepNumber,
  matchClarifyOption,
  modelClarifyOptions,
  checkinSoFar,
  checkinStageQuestion,
  checkinPausedCard,
  checkinStillResumable,
  parseSqliteUtc,
  JOURNAL_SCORE_STAGES,
  pregnancyStatus,
  generateJournalSummary as coreGenerateJournalSummary,
  generateRecommendations as coreGenerateRecommendations,
  extractWeeklySymptoms as coreExtractWeeklySymptoms,
  generateWeeklyInsights as coreGenerateWeeklyInsights,
} from '@amaaii/core';
import type {
  JournalAnalytics,
  JournalPatch,
  JournalStage,
  JournalSummaryData,
  DangerSignResult,
  SymptomHistoryEntry,
  ClarifyOption,
  JournalFields,
  PendingClarify,
} from '@amaaii/core';

interface JournalResponseSuccess {
  response: string;
  nextStage?: JournalStage;
  completed: boolean;
  /** The answer wasn't an answer — it was a question or a new topic. The
   *  session has been paused and the caller should route the message
   *  normally (the 2026-10 simulation's "journal trap"). */
  passThrough?: boolean;
  /** She picked the "I feel unwell"/"Pain N/10" option: the session is
   *  paused and the caller should triage her message (passThrough too). */
  unwell?: boolean;
  /** Reply options for a "what did you mean?" question (buttons on Meta
   *  WhatsApp, chips in the app, a numbered list elsewhere). */
  options?: string[];
  /** Her score answer also mentioned a symptom — worth a triage look. */
  mentionsSymptom?: boolean;
}

type JournalChannel = 'whatsapp' | 'web';

// Per-stage retry counts live in the session blob under this key, never
// in the journals row itself.
const ATTEMPTS_KEY = '__attempts';
// An open "what did you mean?" question (core PendingClarify).
const CLARIFY_KEY = '__clarify';
// Set while the check-in waits for her to tap Resume (core checkinResume.ts).
const PAUSED_KEY = '__paused';

// Every answer column of a journals row, cleared by Restart. Red flags stay:
// starting over never erases a danger sign she reported.
const CLEARED_ANSWERS: JournalPatch = {
  emotional_state: null,
  mood_description: null,
  physical_symptoms: null,
  sleep_quality: null,
  sleep_hours: null,
  appetite: null,
  baby_movement_count: null,
  baby_movement_time: null,
  water_intake: null,
  questions_for_doctor: null,
  special_notes: null,
};

interface AnswerRead {
  fields: JournalFields | null;
  clarify?: ClarifyOption[];
  /** The model's own wording for the clarify question. */
  clarifyMessage?: string;
  /** The clarify model's call on whether she was answering at all; unset =
   *  the word-count rule (looksLikeOffTopic) decides. */
  offTopic?: boolean;
  unwell?: boolean;
  symptom?: boolean;
}

// The regex reading of a score answer, used as-is for short replies and
// whenever the model can't be asked.
function deterministicFields(stage: string, message: string): JournalFields | null {
  switch (stage) {
    case 'mood': return validJournalFields(stage, { mood: coreExtractNumber(message) });
    case 'sleep': return validJournalFields(stage, parseSleepAnswer(message));
    case 'baby_movement': return validJournalFields(stage, { count: coreExtractNumber(message) });
    case 'water': return validJournalFields(stage, { glasses: coreExtractNumber(message) });
    case 'appetite': return validJournalFields(stage, { appetite: parseAppetiteAnswer(message) });
    default: return null;
  }
}

// Every value in `base` appears, unchanged, in `reading`.
function agreesWith(reading: JournalFields, base: JournalFields): boolean {
  return (Object.keys(base) as (keyof JournalFields)[]).every((k) => reading[k] === base[k]);
}

function singleSmallNumber(message: string): number | null {
  const nums = message.match(/\d+/g);
  if (!nums || nums.length !== 1) return null;
  const n = Number(nums[0]);
  return n >= 1 && n <= 10 ? n : null;
}

interface JournalResponseError {
  error: true;
  message: string;
}

type JournalResponseResult = JournalResponseSuccess | JournalResponseError;

interface JournalSessionView {
  userPhone: string;
  currentStage: string;
  journalData: Record<string, unknown>;
  journalId: number | null;
  channel: string;
  startedAt: string | null;
  updatedAt: string | null;
  /** Waiting for her to tap Resume. */
  paused: boolean;
}

function sessionView(userPhone: string, row: {
  currentStage: string;
  journalData?: Record<string, unknown> | null;
  journalId: number | null;
  channel?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
}): JournalSessionView {
  const journalData = row.journalData || {};
  return {
    userPhone,
    currentStage: row.currentStage,
    journalData,
    journalId: row.journalId,
    channel: row.channel ?? 'whatsapp',
    startedAt: row.startedAt ?? null,
    updatedAt: row.updatedAt ?? null,
    paused: journalData[PAUSED_KEY] === true,
  };
}

// Free-text journal stages (questions, notes) re-run symptom + danger
// detection so anything disclosed there isn't silently logged. Mutates
// `journalUpdate` (merges new symptoms, sets red_flags_detected) and
// returns a heads-up string to prepend to the bot's reply, or '' if
// nothing was found. The actual scanning is pure (core.scanFreeText);
// this wrapper just applies the resulting patch to journalUpdate.
function applyFreeTextScan(
  message: string,
  journalData: Record<string, unknown> | null | undefined,
  journalUpdate: JournalPatch,
  lang = 'en'
): string {
  const existing = journalUpdate.physical_symptoms != null
    ? journalUpdate.physical_symptoms
    // journalData is a loosely-typed session blob (a JSON column read
    // back from the DB) — its fields aren't statically known, matching
    // the original's dynamic property access.
    : (journalData as { physical_symptoms?: string | null } | null | undefined)?.physical_symptoms;
  const result = scanFreeText(message, existing, lang);
  if (result.physicalSymptomsPatch !== undefined) journalUpdate.physical_symptoms = result.physicalSymptomsPatch;
  if (result.redFlagsPatch !== undefined) journalUpdate.red_flags_detected = result.redFlagsPatch;
  return result.headsUp;
}

class JournalManager {
  // Sessions are persisted to the journal_sessions table; this manager
  // is now stateless. (Phase 0 §7.5: drop in-memory Map so sessions
  // survive restarts.)

  async startJournalSession(
    userPhone: string,
    _user: unknown,
    channel: JournalChannel = 'whatsapp'
  ): Promise<JournalSessionView> {
    // If there's an active session in the DB, resume it (e.g. after a
    // server restart mid-flow). Otherwise create a fresh journal row
    // and a new session pointing at it — this enables multi-checkin per
    // day: each `journal` command after a previous one completes opens
    // a brand-new row.
    const existingDbSession = await db.getJournalSession(userPhone);
    if (existingDbSession) return sessionView(userPhone, existingDbSession);

    // INSERT the row up front so we capture started_at the moment the
    // user opens the check-in.
    const journalId = await db.createOrUpdateJournal(userPhone, {});

    const session: JournalSessionView = {
      userPhone,
      currentStage: 'greeting',
      journalData: {},
      journalId,
      channel,
      startedAt: null,
      updatedAt: null,
      paused: false,
    };
    await db.upsertJournalSession(userPhone, {
      currentStage: session.currentStage,
      journalData: session.journalData,
      journalId,
      channel,
    });
    return session;
  }

  async getJournalSession(userPhone: string): Promise<JournalSessionView | null> {
    const row = await db.getJournalSession(userPhone);
    return row ? sessionView(userPhone, row) : null;
  }

  /** Still resumable: it started today (Nairobi). An older one is closed,
   *  its answers kept as an incomplete entry. */
  isResumable(session: JournalSessionView, now: Date): boolean {
    return checkinStillResumable(parseSqliteUtc(session.startedAt ?? session.updatedAt), now);
  }

  /** Leaves the check-in waiting for her to tap Resume. `patch` is saved
   *  into the session too (what the paused card shows). */
  async pauseJournal(userPhone: string, patch: JournalPatch = {}): Promise<void> {
    const s = await db.getJournalSession(userPhone);
    if (!s) return;
    await db.upsertJournalSession(userPhone, {
      currentStage: s.currentStage as JournalStage,
      journalData: { ...(s.journalData || {}), ...patch, [PAUSED_KEY]: true, [CLARIFY_KEY]: undefined },
      journalId: s.journalId,
      channel: s.channel ?? 'whatsapp',
    });
  }

  /** What she sees about a paused check-in: what's saved, what's next, and
   *  the Resume / Restart / Stop buttons' words. */
  pausedCard(
    session: JournalSessionView,
    lang: string,
    key: 'journal_paused_card' | 'journal_pending_card' = 'journal_paused_card'
  ): string {
    return checkinPausedCard(session.journalData, session.currentStage, lang, key);
  }

  /** Picks the check-in up on this channel at the question she stopped at. */
  async resumeJournal(userPhone: string, channel: JournalChannel): Promise<string> {
    const s = await db.getJournalSession(userPhone);
    if (!s) return '';
    const user = await db.getUser(userPhone);
    const lang = pickLang(user && user.language);
    const journalData: Record<string, unknown> = { ...(s.journalData || {}), [PAUSED_KEY]: undefined, [CLARIFY_KEY]: undefined };
    const stage = (s.currentStage === 'greeting' || s.currentStage === 'continue' ? 'mood' : s.currentStage) as JournalStage;
    await db.upsertJournalSession(userPhone, { currentStage: stage, journalData, journalId: s.journalId, channel });
    return t(lang, 'journal_resume', { sofar: checkinSoFar(journalData, lang), question: checkinStageQuestion(stage, lang) });
  }

  /** Clears today's answers on the same entry and starts again from the
   *  greeting; the caller runs the greeting turn. */
  async restartJournal(userPhone: string, channel: JournalChannel): Promise<void> {
    const s = await db.getJournalSession(userPhone);
    const journalId = s?.journalId
      ? await db.createOrUpdateJournal(userPhone, CLEARED_ANSWERS, s.journalId)
      : await db.createOrUpdateJournal(userPhone, {});
    await db.upsertJournalSession(userPhone, { currentStage: 'greeting', journalData: {}, journalId, channel });
  }

  /** Ends an open session without completing it (the "stop"/"acha"
   *  command, or a stale/abandoned session). The partial journals row
   *  stays, marked incomplete. */
  async cancelJournal(userPhone: string): Promise<void> {
    await db.deleteJournalSession(userPhone);
  }

  /** A CRITICAL/HIGH danger sign arrived mid-journal: record it on the
   *  in-progress journal row and pause the session, so the caller can run
   *  the normal escalation path (copy, audit, follow-up). */
  async interruptForDanger(userPhone: string, message: string, danger: DangerSignResult): Promise<void> {
    const session = await db.getJournalSession(userPhone);
    if (!session) return;
    const patch: JournalPatch = {
      red_flags_detected: JSON.stringify(danger.detectedSigns),
    };
    if (session.currentStage === 'symptoms') {
      patch.physical_symptoms = parseSymptomsAnswer(message).value;
    }
    if (session.journalId) {
      await db.createOrUpdateJournal(userPhone, patch, session.journalId);
    }
    await this.pauseJournal(userPhone, patch);
  }

  /**
   * The stronger clarify model (llmExtract.clarifyJournalAnswer) settles an
   * unclear answer or writes the "what did you mean?" question. Everything
   * it returns is validated here; null means "use the canned question".
   */
  private async modelClarify(
    stage: string,
    question: string | null,
    message: string,
    journalData: Record<string, unknown>,
    lang: string,
    mustAsk: boolean
  ): Promise<AnswerRead | null> {
    const plan = await llm.clarifyJournalAnswer({
      stage,
      question,
      answer: message,
      soFar: checkinSoFar(journalData, 'en'),
      lang,
    });
    if (!plan) return null;
    if (plan.action === 'off_topic') return mustAsk ? null : { fields: null, offTopic: true };
    if (plan.action === 'save') {
      // A bare "7" to a two-part question is never settled by a guess: the
      // pain option has to be offered (prod, 2026-10-20).
      if (mustAsk) return null;
      const fields = validJournalFields(stage, plan.answer);
      return fields ? { fields } : null;
    }
    const text = plan.message.replace(/[ \t]+/g, ' ').trim();
    if (!text || text.length > 400 || /\[[A-Z_]+\]/.test(text)) return null;
    const clarify = modelClarifyOptions(plan.options, stage, lang, singleSmallNumber(message));
    if (mustAsk && !clarify.length) return null;
    return { fields: null, clarify, clarifyMessage: text };
  }

  /**
   * Reads a score-stage answer against the question she was asked: a pick
   * from an open "what did you mean?" question first, then the regex for
   * short replies, then the model (with the question) for anything longer
   * or unreadable. A reply that is unclear goes to the stronger clarify
   * model, which settles it or asks "what did you mean?" with options —
   * once; the canned question is the fallback, and a second unclear reply
   * is left blank.
   */
  private async readAnswer(
    userPhone: string,
    stage: string,
    message: string,
    pending: PendingClarify | null,
    canAi: boolean,
    lang: string,
    journalData: Record<string, unknown> = {}
  ): Promise<AnswerRead> {
    let clarifiedBefore = false;
    if (pending && pending.stage === stage) {
      const i = matchClarifyOption(message, pending.options);
      if (i !== null) {
        const picked = pending.options[i];
        return picked.unwell ? { fields: null, unwell: true } : { fields: picked.fields ?? null };
      }
      clarifiedBefore = true;
    }
    const symptom = extractSymptoms(message).length > 0;
    const question = async (): Promise<string | null> =>
      (await db.getLastBotMessage(userPhone).catch(() => null))?.response ?? null;
    const bare = stage === 'sleep' && !clarifiedBefore ? bareSleepNumber(message) : null;
    if (bare !== null) {
      const asked = canAi ? await this.modelClarify(stage, await question(), message, journalData, lang, true) : null;
      if (asked) return { ...asked, symptom };
      const clarify = buildClarifyOptions([{ quality: bare }, { hours: bare }], lang, bare);
      if (clarify) return { fields: null, clarify, symptom };
    }
    const det = deterministicFields(stage, message);
    const short = message.trim().split(/\s+/).length <= 5;
    if (!canAi || (det && short)) return { fields: det, symptom };

    const asked = await question();
    const ai = await llm.interpretJournalAnswer(stage, asked, message);
    if (!ai) return { fields: det, symptom };
    const mentions = symptom || ai.symptom !== '';
    const answer = validJournalFields(stage, ai.answer);
    if (ai.status === 'clear') return { fields: answer ?? det, symptom: mentions };
    let readings: JournalFields[] = [];
    if (ai.status === 'ambiguous') {
      readings = ai.readings
        .map((r) => validJournalFields(stage, r))
        .filter((r): r is JournalFields => r !== null);
      // Readings that only add values she never gave ("5 hours" read as
      // 3/10 + 5 hours) are not a real choice: keep what she said.
      if (answer && readings.every((r) => agreesWith(r, answer))) return { fields: answer, symptom: mentions };
    }
    // Unclear: ambiguous, or no value at all. A question ("?") pauses the
    // check-in straight away; for anything else the clarify model decides
    // whether she was answering (a long reply often is). A baby-movement
    // reply in words is kept as text, so it isn't chased.
    const unclear = ai.status === 'ambiguous' || (stage !== 'baby_movement' && !message.includes('?'));
    if (unclear && !clarifiedBefore) {
      const settled = await this.modelClarify(stage, asked, message, journalData, lang, false);
      if (settled) return { ...settled, symptom: mentions };
      if (ai.status === 'ambiguous') {
        const clarify = buildClarifyOptions(readings, lang, singleSmallNumber(message));
        if (clarify) return { fields: null, clarify, symptom: mentions };
      }
    }
    if (ai.status === 'ambiguous') return { fields: readings.length === 1 ? readings[0] : null, symptom: mentions };
    return { fields: null, symptom: mentions };
  }

  /**
   * `opts.canAi` (default true, for direct callers/tests): with the optional
   * ai_responses consent declined, the llm.extract* fallbacks below are
   * skipped and only the deterministic parsers run — declining AI must
   * mean the model never sees her words.
   */
  async processJournalResponse(
    userPhone: string,
    message: string,
    currentStage?: string,
    opts: { canAi?: boolean } = {}
  ): Promise<JournalResponseResult> {
    const canAi = opts.canAi !== false;
    const dbSession = await db.getJournalSession(userPhone);
    if (!dbSession) {
      return { error: true, message: 'No active journal session' };
    }
    // The DB stores currentStage as a bare string column; the core
    // state machine's type is the narrower JournalStage union. Every
    // value that ever lands in that column originated from
    // nextJournalStage()'s own return values, so this cast is safe.
    const stage = (currentStage || dbSession.currentStage) as JournalStage;
    const journalData = dbSession.journalData || {};
    const journalId = dbSession.journalId || null;
    const attempts = { ...((journalData[ATTEMPTS_KEY] as Record<string, number> | undefined) || {}) };
    const tries = (key: string): number => attempts[key] ?? 0;
    let passThrough = false;
    const user = await db.getUser(userPhone);
    // Derived from edd (not the onboarding snapshot); postpartum mothers
    // count as week 0 here so the fetal-movement stage is skipped.
    const status = user ? pregnancyStatus(user, new Date()) : null;
    const pregnancyWeek = status?.phase === 'pregnant' ? status.week : 0;
    const lang = pickLang(user && user.language);

    let nextStage: JournalStage | undefined;
    // Initialized for strict definite-assignment; every case below
    // overwrites it exactly like the original (never actually observed
    // as '' — all 11 JournalStage values are handled below).
    let response = '';
    const journalUpdate: JournalPatch = {};
    let mentionsSymptom = false;
    let fields: JournalFields | null = null;
    // A question or a new topic, not an answer: the check-in pauses.
    let offTopic = looksLikeOffTopic(message);

    if (JOURNAL_SCORE_STAGES.has(stage)) {
      const pending = (journalData[CLARIFY_KEY] as PendingClarify | undefined) ?? null;
      const read = await this.readAnswer(userPhone, stage, message, pending, canAi, lang, journalData);
      if (read.unwell) {
        await this.pauseJournal(userPhone);
        return { response: '', completed: false, passThrough: true, unwell: true };
      }
      if (read.clarify) {
        const clarify: PendingClarify = { stage, options: read.clarify };
        // A clarify counts as one try: an answer still unreadable after it
        // is skipped (mood, water) rather than asked a third time.
        attempts[stage] = tries(stage) + 1;
        await db.upsertJournalSession(userPhone, {
          currentStage: stage,
          journalData: { ...journalData, [CLARIFY_KEY]: clarify, [ATTEMPTS_KEY]: attempts },
          journalId,
          channel: dbSession.channel ?? 'whatsapp',
        });
        const answer = message.trim().replace(/\s+/g, ' ').slice(0, 60);
        return {
          response: read.clarifyMessage ?? t(lang, 'journal_clarify', { answer }),
          ...(read.clarify.length ? { options: read.clarify.map((o) => o.label) } : {}),
          nextStage: stage,
          completed: false,
          mentionsSymptom: !!read.symptom,
        };
      }
      fields = read.fields;
      mentionsSymptom = !!read.symptom;
      if (read.offTopic !== undefined) offTopic = read.offTopic;
    }

    switch (stage) {
      case 'greeting':
      case 'continue': {
        nextStage = nextJournalStage(stage, { pregnancyWeek });
        const baseGreeting = stage === 'continue'
          ? t(lang, 'journal_continue')
          : t(lang, 'journal_greeting');

        // Context-aware preamble: if yesterday's check-in flagged
        // symptoms, ask about them first. Soft, no medical claims.
        let preamble = '';
        try {
          const trend = await getRecentTrend(userPhone, 7);
          if (trend) {
            if (trend.yesterdaySymptoms.length === 1) {
              preamble = t(lang, 'journal_yesterday_followup_one', { symptom: trend.yesterdaySymptoms[0] });
            } else if (trend.yesterdaySymptoms.length > 1) {
              preamble = t(lang, 'journal_yesterday_followup_many', { list: trend.yesterdaySymptoms.join(', ') });
            } else if (trend.distinctDaysJournaled >= 5) {
              // Reward consistency without nagging — only every several days.
              preamble = t(lang, 'journal_streak', { days: trend.distinctDaysJournaled });
            }
          }
        } catch (_) { /* trend is best-effort */ }

        response = preamble + baseGreeting;
        break;
      }

      case 'mood': {
        const moodScore = fields?.mood ?? null;
        const moodValid = moodScore !== null;
        if (!moodValid && offTopic) {
          passThrough = true;
          break;
        }
        // Two unparseable answers in a row: skip the rating rather than
        // asking the same question forever.
        const skipMood = !moodValid && tries('mood') >= 1;
        nextStage = nextJournalStage(stage, { pregnancyWeek, moodValid: moodValid || skipMood });
        if (skipMood) {
          response = t(lang, 'journal_mood_followup', { ack: t(lang, 'journal_mood_skip') });
        } else if (moodValid) {
          journalUpdate.emotional_state = moodScore as number;
          journalUpdate.mood_description = message;
          const ack =
            (moodScore as number) >= 7 ? t(lang, 'journal_mood_good') :
            (moodScore as number) >= 5 ? t(lang, 'journal_mood_ok') :
            t(lang, 'journal_mood_low');
          response = t(lang, 'journal_mood_followup', { ack });
        } else {
          attempts.mood = tries('mood') + 1;
          response = t(lang, 'journal_mood_invalid');
        }
        break;
      }

      case 'symptoms': {
        if (message.includes('?')) {
          passThrough = true;
          break;
        }
        const { value } = parseSymptomsAnswer(message);
        journalUpdate.physical_symptoms = value;
        const dangerAnalysis = detectDangerSigns(message);
        nextStage = nextJournalStage(stage, { pregnancyWeek, dangerUrgency: dangerAnalysis.urgencyLevel });

        if (nextStage === 'completed') {
          journalUpdate.red_flags_detected = JSON.stringify(dangerAnalysis.detectedSigns);
          response = `${dangerCopy(dangerAnalysis.urgencyLevel, lang)}\n\n${t(lang, 'journal_pause')}`;
        } else {
          response = t(lang, 'journal_symptoms_noted');
        }
        break;
      }

      case 'sleep': {
        if (fields?.quality != null) journalUpdate.sleep_quality = fields.quality;
        if (fields?.hours != null) journalUpdate.sleep_hours = fields.hours;

        if (journalUpdate.sleep_quality == null && journalUpdate.sleep_hours == null && offTopic) {
          passThrough = true;
          break;
        }
        nextStage = nextJournalStage(stage, { pregnancyWeek });
        response = nextStage === 'baby_movement'
          ? t(lang, 'journal_baby_movement_q')
          : t(lang, 'journal_water_q');
        break;
      }

      case 'baby_movement': {
        const movementCount = fields?.count ?? null;
        if (movementCount === null && offTopic) {
          passThrough = true;
          break;
        }
        const water_q = t(lang, 'journal_water_q');
        if (movementCount !== null) {
          journalUpdate.baby_movement_count = movementCount;
          if (movementCount === 0 && pregnancyWeek > 28) {
            journalUpdate.red_flags_detected = JSON.stringify(['no_fetal_movement']);
            response = t(lang, 'journal_movement_warn', { water_q });
          } else if (movementCount < 10 && pregnancyWeek > 28) {
            response = t(lang, 'journal_movement_low', { water_q });
          } else {
            response = t(lang, 'journal_movement_good', { water_q });
          }
        } else {
          journalUpdate.baby_movement_time = message;
          response = t(lang, 'journal_movement_noted', { water_q });
        }
        nextStage = nextJournalStage(stage, { pregnancyWeek });
        break;
      }

      case 'water': {
        const waterCount = fields?.glasses ?? null;
        if (waterCount !== null) {
          journalUpdate.water_intake = waterCount;
          const ack =
            waterCount >= 8 ? t(lang, 'journal_water_great') :
            waterCount >= 6 ? t(lang, 'journal_water_ok') :
            t(lang, 'journal_water_low');
          response = t(lang, 'journal_water_followup', { ack });
          nextStage = nextJournalStage(stage, { pregnancyWeek });
        } else if (offTopic) {
          passThrough = true;
        } else if (tries('water') >= 1) {
          response = t(lang, 'journal_water_followup', { ack: t(lang, 'journal_water_skip') });
          nextStage = nextJournalStage(stage, { pregnancyWeek });
        } else {
          // Re-ask once at the same stage (the old code advanced anyway,
          // so the corrected number was then parsed as the appetite).
          attempts.water = 1;
          response = t(lang, 'journal_water_invalid');
          nextStage = stage;
        }
        break;
      }

      case 'appetite': {
        const appetiteLevel: string | null = fields?.appetite ?? null;
        if (appetiteLevel === null && offTopic) {
          passThrough = true;
          break;
        }
        // Unknown stays unknown — never silently record 'moderate'.
        if (appetiteLevel) journalUpdate.appetite = appetiteLevel;
        nextStage = nextJournalStage(stage, { pregnancyWeek });
        response = t(lang, 'journal_questions_q');
        break;
      }

      case 'questions': {
        const lower = message.toLowerCase().trim();
        const isSkipping = lower === 'none' || lower === 'hapana';
        let questionsHeadsUp = '';
        if (!isSkipping) {
          journalUpdate.questions_for_doctor = message;
          questionsHeadsUp = applyFreeTextScan(message, journalData, journalUpdate, lang);
        }
        nextStage = nextJournalStage(stage, { pregnancyWeek });
        response = `${questionsHeadsUp}${t(lang, 'journal_notes_q')}`;
        break;
      }

      case 'notes': {
        const lowerNotes = message.toLowerCase().trim();
        const isDoneSentinel =
          lowerNotes === 'done' || lowerNotes === 'no' || lowerNotes === 'none' ||
          lowerNotes === 'maliza' || lowerNotes === 'hapana';
        let noteHeadsUp = '';
        if (!isDoneSentinel) {
          journalUpdate.special_notes = message;
          noteHeadsUp = applyFreeTextScan(message, journalData, journalUpdate, lang);
        }
        journalUpdate.completed = 1;
        // Stamp the moment the user finished — pairs with started_at
        // (set in startJournalSession) for full duration analytics.
        journalUpdate.completed_at = new Date().toISOString();
        nextStage = nextJournalStage(stage, { pregnancyWeek });
        const summary = await this.generateJournalSummary(journalData, journalUpdate, lang, pregnancyWeek);
        response = noteHeadsUp + summary;
        break;
      }

      case 'completed':
        response = t(lang, 'journal_done');
        break;
    }

    if (passThrough) {
      // Paused, not thrown away: she gets Resume / Restart / Stop.
      await this.pauseJournal(userPhone);
      return { response: '', completed: false, passThrough: true };
    }

    if (Object.keys(journalUpdate).length > 0) {
      // All journal writes go to the SAME row created in
      // startJournalSession — multi-checkin works because each
      // `journal` command after a previous completion creates a fresh
      // row before processJournalResponse is ever called.
      await db.createOrUpdateJournal(userPhone, journalUpdate, journalId);
    }

    // Any answer closes an open "what did you mean?" question.
    const mergedJournalData = { ...journalData, ...journalUpdate, [ATTEMPTS_KEY]: attempts, [CLARIFY_KEY]: undefined };

    if (nextStage === 'completed') {
      await db.deleteJournalSession(userPhone);
    } else {
      await db.upsertJournalSession(userPhone, {
        currentStage: nextStage as JournalStage,
        journalData: mergedJournalData,
        journalId,
        channel: dbSession.channel ?? 'whatsapp',
      });
    }

    return { response, nextStage, completed: nextStage === 'completed', mentionsSymptom };
  }

  async generateJournalSummary(
    existingData: JournalSummaryData,
    newData: JournalSummaryData,
    lang: string | null | undefined = 'en',
    pregnancyWeek = 0
  ): Promise<string> {
    return coreGenerateJournalSummary(existingData, newData, lang, pregnancyWeek);
  }

  generateRecommendations(data: JournalSummaryData, lang: string | null | undefined = 'en'): string[] {
    return coreGenerateRecommendations(data, lang);
  }

  async getWeeklySummary(userPhone: string): Promise<string> {
    const history = await db.getJournalHistory(userPhone, 7);
    const analytics = await db.getJournalAnalytics(userPhone, 7);

    if (!history || history.length === 0) {
      return 'No journal entries found for this week. Start journaling daily to track your pregnancy journey! 📝';
    }

    let summary = '📈 **Your Weekly Summary**\n\n';

    summary += `**Journals Completed:** ${analytics.journal_count}/7 days\n`;

    if (analytics.avg_mood) summary += `**Average Mood:** ${analytics.avg_mood.toFixed(1)}/10\n`;
    if (analytics.avg_energy) summary += `**Average Energy:** ${analytics.avg_energy.toFixed(1)}/10\n`;
    if (analytics.avg_sleep) summary += `**Average Sleep Quality:** ${analytics.avg_sleep.toFixed(1)}/10\n`;
    if (analytics.avg_water) summary += `**Average Water Intake:** ${analytics.avg_water.toFixed(0)} glasses/day\n`;

    if (analytics.red_flag_days > 0) {
      summary += `\n⚠️ **Alert:** Red flags detected on ${analytics.red_flag_days} day(s). Please discuss with your doctor.\n`;
    }

    const symptoms = this.extractWeeklySymptoms(history);
    if (symptoms.length > 0) {
      summary += `\n**Common Symptoms This Week:**\n`;
      symptoms.forEach((symptom) => (summary += `• ${symptom}\n`));
    }

    summary += this.generateWeeklyInsights(analytics, history);

    return summary;
  }

  extractWeeklySymptoms(history: SymptomHistoryEntry[]): string[] {
    return coreExtractWeeklySymptoms(history);
  }

  generateWeeklyInsights(analytics: JournalAnalytics, history: SymptomHistoryEntry[]): string {
    return coreGenerateWeeklyInsights(analytics, history);
  }

  async generateDoctorReport(userPhone: string, days = 30): Promise<string> {
    const history = await db.getJournalHistory(userPhone, days);
    const user = await db.getUser(userPhone);

    // `user` is assumed present, matching the original JS exactly
    // (including that a missing user would throw here, not silently
    // produce a half-empty report).
    let report = `**Pregnancy Health Report**\n`;
    report += `Patient: ${user!.name || 'Not provided'}\n`;
    report += `Age: ${user!.age || 'Not provided'}\n`;
    report += `Current Week: ${user!.pregnancy_week ?? 'Not provided'}\n`;
    report += `Report Period: Last ${days} days\n\n`;

    report += `**Summary of Symptoms:**\n`;
    const symptoms = this.extractWeeklySymptoms(history);
    symptoms.forEach((symptom) => (report += `• ${symptom}\n`));

    report += `\n**Red Flags Noted:**\n`;
    const redFlags = history.filter((j) => j.red_flags_detected);
    if (redFlags.length > 0) {
      redFlags.forEach((entry) => {
        report += `• ${entry.date}: ${entry.red_flags_detected}\n`;
      });
    } else {
      report += '• None\n';
    }

    report += `\n**Questions from Patient:**\n`;
    const questions = history.filter((j) => j.questions_for_doctor).map((j) => j.questions_for_doctor);
    if (questions.length > 0) {
      questions.forEach((q) => (report += `• ${q}\n`));
    } else {
      report += '• None\n';
    }

    return report;
  }

  extractNumber(message: string): number | null {
    return coreExtractNumber(message);
  }

  // Whole-message commands (packages/core/src/commands.ts). The old
  // substring matchers fired on "recheck in", "what is journal?" and on
  // "journal summary" itself.
  isJournalCommand(message: string): boolean {
    return parseCommand(message) === 'journal';
  }

  isSummaryCommand(message: string): boolean {
    const cmd = parseCommand(message);
    return cmd === 'summary' || cmd === 'weekly_summary';
  }

  isDoctorReportCommand(message: string): boolean {
    return parseCommand(message) === 'doctor_report';
  }
}

export = new JournalManager();
