const { sendWhatsAppMessage } = require('../services/twilio');
const { getAmaaiiResponse } = require('../services/amaaii');
const { detectDangerSigns, assessMood, extractSymptoms } = require('../services/dangerSigns');
const userManager = require('./userManager');
const db = require('../services/database');
const journalManager = require('../services/journalManager');
const { log } = require('./logger');
const { t, pickLang } = require('../services/i18n');

function dangerCopy(level, lang) {
  if (level === 'critical') return t(lang, 'danger_critical');
  if (level === 'high') return t(lang, 'danger_high');
  if (level === 'moderate') return t(lang, 'danger_moderate');
  return '';
}

// We compare against BOTH the EN and SW reminder markers when checking
// "did we already nudge the user this session?" — language can change
// between turns.
const JOURNAL_REMINDER_MARKERS = [
  t('en', 'journal_reminder'),
  t('sw', 'journal_reminder'),
];

// Pure(-ish) message processor: derives the bot's response from the
// inbound message + DB state, persists the turn, and returns the result.
// No outbound transport (Twilio / HTTP) — callers handle delivery.
//
// Returns: { response, urgencyLevel, context }
async function processMessage(from, message, profileName) {
  log.info(`Processing message from ${from}`, { profileName, message });

  const user = await userManager.getOrCreateUser(from, profileName);
  const userContext = userManager.getUserContext(user);
  const lang = pickLang(user.language);

  log.info('User context', userContext);

  let response = '';
  let conversationContext = 'general';
  let dangerSignAnalysis = null;

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
      const result = await journalManager.processJournalResponse(from, message, session.currentStage);
      response = result.response;
    } else {
      // Manager handles its own session deletion on completion.
      const result = await journalManager.processJournalResponse(from, message, activeJournalSession.currentStage);
      response = result.response;
    }
    conversationContext = 'journaling';
  } else if (journalManager.isSummaryCommand(message)) {
    if (message.toLowerCase().includes('weekly')) {
      response = await journalManager.getWeeklySummary(from);
    } else {
      const todaysJournal = await db.getTodaysJournal(from);
      if (todaysJournal) {
        response = await journalManager.generateJournalSummary(todaysJournal, {});
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

      response = await getAmaaiiResponse(message, {
        userName: user.name,
        isNewUser: userContext.isNewUser,
        conversationHistory,
        currentContext: conversationContext,
        language: lang,
      });

      if (symptoms.length > 0) {
        await db.saveSymptoms(from, symptoms, mood, dangerSignAnalysis.urgencyLevel);
      }

      // Deterministic journal reminder (D19): append iff user hasn't
      // journaled today AND no recent bot turn already nudged them
      // (in either language).
      const todaysJournal = await db.getTodaysJournal(from);
      if (!todaysJournal) {
        const remindedRecently = (conversationHistory || []).some(
          (turn) => turn.response && JOURNAL_REMINDER_MARKERS.some((m) => turn.response.includes(m))
        );
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
      ? { dangerSigns: [], urgencyLevel: 'low', context: conversationContext }
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
async function handleIncomingMessage(from, message, profileName) {
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
  "What's your name?",  // EN
  "Jina lako ni nani?", // SW
];

async function handleOnboarding(user, message, phoneNumber, lang = 'en') {
  if (!user.name) {
    const lastBot = await db.getLastBotMessage(phoneNumber);
    const previousWasNamePrompt =
      lastBot && lastBot.response &&
      NAME_PROMPT_MARKERS.some((m) => lastBot.response.includes(m));
    if (previousWasNamePrompt) {
      const trimmedName = message.trim();
      if (trimmedName.length > 0) {
        await userManager.updateUserProfile(phoneNumber, { name: trimmedName });
        return t(lang, 'name_thanks', { name: trimmedName });
      }
    }
    return t(lang, 'name_prompt');
  }

  if (!user.age) {
    const ageMatch = message.match(/\d+/);
    if (ageMatch) {
      const age = parseInt(ageMatch[0]);
      await userManager.updateUserProfile(user.phone_number, { age });
      return t(lang, 'age_thanks');
    }
    return t(lang, 'age_prompt_again', { name: user.name });
  }

  if (!user.pregnancy_week) {
    // Accept "20 weeks" (EN) or "wiki 20" / "20 wiki" (SW).
    const weeksMatch =
      message.match(/(\d+)\s*weeks?/i) ||
      message.match(/(\d+)\s*wiki/i) ||
      message.match(/wiki\s*(\d+)/i);
    const lmpMatch = message.match(/\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);

    if (weeksMatch) {
      const weeks = parseInt(weeksMatch[1]);
      const edd = calculateEDDFromWeeks(weeks);
      await userManager.updateUserProfile(user.phone_number, { pregnancy_week: weeks, edd });
      return t(lang, 'week_thanks', { weeks });
    } else if (lmpMatch) {
      const lmp = lmpMatch[0];
      const weeks = userManager.calculatePregnancyWeek(lmp);
      const edd = userManager.calculateEDD(lmp);
      await userManager.updateUserProfile(user.phone_number, { pregnancy_week: weeks, edd, lmp });
      return t(lang, 'week_lmp_thanks', { weeks, edd });
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

function calculateEDDFromWeeks(currentWeeks) {
  const today = new Date();
  const daysPregnant = currentWeeks * 7;
  const daysRemaining = 280 - daysPregnant;
  const edd = new Date(today);
  edd.setDate(edd.getDate() + daysRemaining);
  return edd.toISOString().split('T')[0];
}

function checkIfMentalHealth(message) {
  const mentalHealthKeywords = [
    'sad', 'depressed', 'anxious', 'worried', 'scared', 'afraid',
    'crying', 'mood', 'emotional', 'stressed', 'overwhelmed',
    'panic', 'hopeless', 'alone', 'isolated',
  ];
  const lowerMessage = message.toLowerCase();
  return mentalHealthKeywords.some((keyword) => lowerMessage.includes(keyword));
}

module.exports = { handleIncomingMessage, processMessage };
