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
  cleanName,
  parseWeekOrLMP,
  calculateEDDFromWeeks,
} from '@amaaii/core';
import type { UpdateUserInput } from '@amaaii/core';
import userManager, { type UserWithFlag } from './userManager';
import * as db from './database';
import journalManager from './journalManager';
import { log } from './logger';
import { getRecentTrend, trendForPrompt } from './trend';
import * as llm from './llmExtract';

// We compare against BOTH the EN and SW reminder markers when checking
// "did we already nudge the user this session?" — language can change
// between turns.
const JOURNAL_REMINDER_MARKERS = [
  t('en', 'journal_reminder'),
  t('sw', 'journal_reminder'),
];

export interface ProcessMessageResult {
  response: string;
  urgencyLevel: string;
  context: string;
}

// Pure(-ish) message processor: derives the bot's response from the
// inbound message + DB state, persists the turn, and returns the result.
// No outbound transport (Twilio / HTTP) — callers handle delivery.
export async function processMessage(
  from: string,
  message: string,
  profileName: string | null
): Promise<ProcessMessageResult> {
  log.info(`Processing message from ${from}`, { profileName, message });

  const user = await userManager.getOrCreateUser(from, profileName);
  const userContext = userManager.getUserContext(user);
  const lang = pickLang(user.language);

  log.info('User context', userContext);

  let response = '';
  let conversationContext = 'general';
  let dangerSignAnalysis: ReturnType<typeof detectDangerSigns> | null = null;

  // Onboarding takes precedence over every command except CRITICAL
  // danger signs (per spec §7.4). Otherwise un-onboarded users could
  // type `journal` (or paste anything) and bypass the profile capture
  // entirely, leaving downstream features without context.
  const earlyDanger = detectDangerSigns(message);
  if (earlyDanger.urgencyLevel !== 'critical' && userContext.needsOnboarding) {
    conversationContext = 'onboarding';
    response = await handleOnboarding(user, message, from, lang);
    if (
      earlyDanger.urgencyLevel === 'high' ||
      earlyDanger.urgencyLevel === 'moderate'
    ) {
      response = `${dangerCopy(earlyDanger.urgencyLevel, lang)}\n\n${response}`;
    }
    const sx = extractSymptoms(message);
    if (sx.length > 0) {
      await db.saveSymptoms(from, sx, assessMood(message), earlyDanger.urgencyLevel);
    }
    await db.saveConversation(from, message, response, {
      dangerSigns: earlyDanger.detectedSigns || [],
      urgencyLevel: earlyDanger.urgencyLevel,
      context: conversationContext,
    });
    return { response, urgencyLevel: earlyDanger.urgencyLevel, context: conversationContext };
  }

  // Active journal session (DB-backed since 7.5).
  const activeJournalSession = await journalManager.getJournalSession(from);

  if (journalManager.isJournalCommand(message) || activeJournalSession) {
    if (!activeJournalSession) {
      const session = await journalManager.startJournalSession(from, user);
      // processJournalResponse only returns the {error} shape when there
      // is no active session in the DB — we just created/fetched one, so
      // this narrows away that compile-time-only variant. If it were
      // ever wrong at runtime, `.response` would simply read as
      // `undefined`, same as the original JS's unchecked property access.
      const result = await journalManager.processJournalResponse(from, message, session.currentStage) as { response: string };
      response = result.response;
    } else {
      // Manager handles its own session deletion on completion.
      const result = await journalManager.processJournalResponse(from, message, activeJournalSession.currentStage) as { response: string };
      response = result.response;
    }
    conversationContext = 'journaling';
  } else if (journalManager.isSummaryCommand(message)) {
    if (message.toLowerCase().includes('weekly')) {
      response = await journalManager.getWeeklySummary(from);
    } else {
      const todaysJournal = await db.getTodaysJournal(from);
      if (todaysJournal) {
        // JournalRow (a concrete DB row shape) vs. JournalSummaryData
        // (a loosely-typed bag with a catch-all index signature) are
        // structurally compatible in practice but TS's assignability
        // rules don't bridge "no index signature" -> "has one" for two
        // separately-declared interfaces without a cast.
        response = await journalManager.generateJournalSummary(todaysJournal as typeof todaysJournal & Record<string, unknown>, {});
      } else {
        response = "You haven't completed today's journal yet. Type 'journal' to start!";
      }
    }
    conversationContext = 'journal_summary';
  } else if (journalManager.isDoctorReportCommand(message)) {
    response = await journalManager.generateDoctorReport(from, 30);
    conversationContext = 'doctor_report';
  } else {
    dangerSignAnalysis = detectDangerSigns(message);
    const mood = assessMood(message);
    const symptoms = extractSymptoms(message);

    log.info('Analysis', { urgencyLevel: dangerSignAnalysis.urgencyLevel, mood, symptoms });

    // Routing precedence (per spec §7.4): CRITICAL short-circuits;
    // un-onboarded users were already routed above; HIGH escalates;
    // everything else goes to the AI.
    if (dangerSignAnalysis.urgencyLevel === 'critical') {
      response = dangerCopy('critical', lang);
      conversationContext = 'danger_sign_detected';
      if (symptoms.length > 0) {
        await db.saveSymptoms(from, symptoms, mood, dangerSignAnalysis.urgencyLevel);
      }
    } else if (dangerSignAnalysis.urgencyLevel === 'high') {
      response = dangerCopy('high', lang);
      conversationContext = 'danger_sign_detected';
      if (symptoms.length > 0) {
        await db.saveSymptoms(from, symptoms, mood, dangerSignAnalysis.urgencyLevel);
      }
    } else {
      const conversationHistory = await db.getConversationHistory(from, 5);

      if (checkIfMentalHealth(message)) {
        conversationContext = 'mental_health';
      }

      const trend = await getRecentTrend(from, 7);
      const trendLine = trendForPrompt(trend);
      const mh = await db.getMedicalHistory(from).catch(() => null);

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

      if (symptoms.length > 0) {
        await db.saveSymptoms(from, symptoms, mood, dangerSignAnalysis.urgencyLevel);
      }

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

  const analysisData =
    conversationContext === 'journaling' ||
    conversationContext === 'journal_summary' ||
    conversationContext === 'doctor_report'
      ? { dangerSigns: [] as unknown[], urgencyLevel: 'low', context: conversationContext }
      : {
          dangerSigns: dangerSignAnalysis?.detectedSigns || [],
          urgencyLevel: dangerSignAnalysis?.urgencyLevel || 'low',
          context: conversationContext,
        };

  await db.saveConversation(from, message, response, analysisData);

  return {
    response,
    urgencyLevel: analysisData.urgencyLevel,
    context: conversationContext,
  };
}

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

    // In-process follow-up for high-risk cases (D20: deferred — proper
    // durable queue lands in Phase 4).
    if (urgencyLevel === 'high' || urgencyLevel === 'critical') {
      setTimeout(async () => {
        const followUp = "Hi! I wanted to check in - were you able to see a healthcare provider? How are you feeling now? 💚";
        await sendWhatsAppMessage(from, followUp);
        await db.saveConversation(from, '[System Follow-up]', followUp, {
          context: 'follow_up',
          dangerSigns: [],
          urgencyLevel: 'low',
        });
      }, 3600000);
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

  if (!user.pregnancy_week) {
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
            if (wk !== null && wk >= 1 && wk <= 42) parsed = { weeks: wk, lmp: out.lmp };
          } else if (out.weeks) {
            parsed = { weeks: out.weeks };
          }
        }
      }
    }

    if (parsed && parsed.weeks && parsed.weeks >= 1 && parsed.weeks <= 42) {
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
