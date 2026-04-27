const { sendWhatsAppMessage } = require('../services/twilio');
const { getAmaaiiResponse } = require('../services/amaaii');
const { detectDangerSigns, assessMood, extractSymptoms } = require('../services/dangerSigns');
const userManager = require('./userManager');
const db = require('../services/database');
const journalManager = require('../services/journalManager');
const { log } = require('./logger');
const { t, pickLang } = require('../services/i18n');
const { getRecentTrend, trendForPrompt } = require('../services/trend');
const llm = require('../services/llmExtract');

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

// Substrings that uniquely identify the week-stage re-prompt. Used to
// count consecutive failed attempts so we can escalate to the LLM
// fallback after the 3rd try.
const WEEK_REPROMPT_MARKERS = [
  "I didn't catch that", // EN re-prompt
  "Sikuelewa",           // SW re-prompt
];

// Liberal parser for the pregnancy-week answer. Returns
// { weeks: int, lmp?: 'YYYY-MM-DD' } or null. Accepts any of:
//   - "20 weeks" / "20 wks" / "i'm at 20" / "20"
//   - "wiki 20" / "20 wiki" (SW)
//   - "22/3/2026" / "2026-03-22" (numeric LMP)
//   - "22 march" / "march 22" / "22nd of march 2026" (month name LMP)
//   - "22 machi" (SW month name)
function parseWeekOrLMP(raw) {
  if (typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();

  // Numeric date forms first (most specific).
  let m = lower.match(/(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})/);
  if (m) {
    const lmp = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    return { weeks: weeksFromLMP(lmp), lmp };
  }
  m = lower.match(/(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{2,4})/);
  if (m) {
    let yr = parseInt(m[3], 10);
    if (yr < 100) yr += 2000;
    const lmp = `${yr}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    return { weeks: weeksFromLMP(lmp), lmp };
  }

  // Month-name forms: "22 march", "march 22", "22nd of march", with
  // optional year. SW months included.
  const MONTHS = {
    jan: 1, january: 1, januari: 1,
    feb: 2, february: 2, februari: 2,
    mar: 3, march: 3, machi: 3,
    apr: 4, april: 4, aprili: 4,
    may: 5, mei: 5,
    jun: 6, june: 6, juni: 6,
    jul: 7, july: 7, julai: 7,
    aug: 8, august: 8, agosti: 8,
    sep: 9, sept: 9, september: 9, septemba: 9,
    oct: 10, october: 10, oktoba: 10,
    nov: 11, november: 11, novemba: 11,
    dec: 12, december: 12, desemba: 12,
  };
  const monthAlt = Object.keys(MONTHS).join('|');
  // "22 march" / "22nd of march" / "22 march 2026"
  m = lower.match(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthAlt})(?:\\s+(\\d{4}))?`, 'i'));
  if (!m) {
    // "march 22" / "march 22 2026"
    m = lower.match(new RegExp(`(${monthAlt})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?`, 'i'));
    if (m) m = [m[0], m[2], m[1], m[3]]; // normalise to [_, day, month, year]
  }
  if (m) {
    const day = parseInt(m[1], 10);
    const mo = MONTHS[m[2].toLowerCase()];
    if (day >= 1 && day <= 31 && mo) {
      const yr = m[3] ? parseInt(m[3], 10) : inferLMPYear(mo);
      const lmp = `${yr}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { weeks: weeksFromLMP(lmp), lmp };
    }
  }

  // Week patterns (most → least specific).
  m =
    lower.match(/(\d+)\s*(?:weeks?|wks?|w\b)/i) ||
    lower.match(/(\d+)\s*wiki/i) ||
    lower.match(/wiki\s*(\d+)/i) ||
    lower.match(/(?:i'?m|im|i\s*am|niko|niko\s*kwa|nina)\s+(?:at\s+|kwa\s+)?(\d+)\b/i);
  if (m) {
    const w = parseInt(m[1], 10);
    if (w >= 1 && w <= 42) return { weeks: w };
  }

  // Last resort: bare integer in a plausible week range, with no other
  // numbers in the message. "22" → 22 weeks. "22 march" was already
  // caught above, so this only fires for genuinely bare numbers.
  m = lower.match(/^\s*(\d+)\s*$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 42) return { weeks: n };
  }

  return null;
}

// LMP year inference: if the month suggests an LMP within ~10 months
// of today, use this year; otherwise last year. Most pregnancies span
// less than a year so this heuristic works in 95%+ of demo cases.
function inferLMPYear(month) {
  const now = new Date();
  const thisYear = now.getUTCFullYear();
  const thisMonth = now.getUTCMonth() + 1;
  // If the named month is in the future relative to today, assume last year.
  return month > thisMonth ? thisYear - 1 : thisYear;
}

function weeksFromLMP(lmp) {
  const lmpDate = new Date(lmp);
  if (Number.isNaN(lmpDate.getTime())) return 0;
  const diffMs = Date.now() - lmpDate.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24 * 7)));
}

// Strip common framing so "Hey, my name is Mboga" / "I'm Mboga" /
// "Hi I am Mboga" / "Habari, jina langu ni Mboga" all yield "Mboga".
function cleanName(raw) {
  let s = (raw || '').trim();
  // Drop a leading greeting if present.
  s = s.replace(/^(?:hey|hi|hello|habari|niaje|sasa|poa|hujambo)\s*[,!.\-]*\s*/i, '');
  // Strip introductions: "my name is X", "I'm X", "I am X", "call me X",
  // SW: "jina langu ni X", "ninaitwa X", "mimi ni X".
  const intros = [
    /^(?:my\s+name\s+is)\s+/i,
    /^(?:i\s*am|i'?m)\s+/i,
    /^(?:call\s+me)\s+/i,
    /^(?:it'?s|this\s+is)\s+/i,
    /^(?:jina\s+langu\s+ni)\s+/i,
    /^(?:ninaitwa)\s+/i,
    /^(?:mimi\s+ni)\s+/i,
  ];
  for (const re of intros) s = s.replace(re, '');
  // If anything is left wrapped in quotes, unwrap.
  s = s.replace(/^["']\s*/, '').replace(/\s*["']$/, '');
  // Final trim + collapse internal whitespace.
  s = s.trim().replace(/\s+/g, ' ');
  // Cap at first sentence-ending punctuation — names don't have periods.
  s = s.split(/[.!?,]/)[0].trim();
  return s;
}

async function handleOnboarding(user, message, phoneNumber, lang = 'en') {
  if (!user.name) {
    const lastBot = await db.getLastBotMessage(phoneNumber);
    const previousWasNamePrompt =
      lastBot && lastBot.response &&
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
      const age = parseInt(ageMatch[0]);
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
      const reprompts = (recent || []).filter(
        (turn) => turn.response && WEEK_REPROMPT_MARKERS.some((m) => turn.response.includes(m))
      ).length;
      if (reprompts >= 2) {
        log.info('Onboarding week: 3-strikes LLM fallback triggered', { phoneNumber, reprompts });
        const out = await llm.extractWeekOrLMP(message).catch(() => null);
        if (out && (out.weeks || out.lmp)) {
          if (out.lmp) {
            const wk = userManager.calculatePregnancyWeek(out.lmp);
            if (wk >= 1 && wk <= 42) parsed = { weeks: wk, lmp: out.lmp };
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
      const update = { pregnancy_week: parsed.weeks, edd };
      if (parsed.lmp) update.lmp = parsed.lmp;
      await userManager.updateUserProfile(user.phone_number, update);
      return parsed.lmp
        ? t(lang, 'week_lmp_thanks', { weeks: parsed.weeks, edd })
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
