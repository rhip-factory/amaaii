const { sendWhatsAppMessage } = require('../services/twilio');
const { getAmaaiiResponse } = require('../services/amaaii');
const { detectDangerSigns, assessMood, extractSymptoms } = require('../services/dangerSigns');
const userManager = require('./userManager');
const db = require('../services/database');
const journalManager = require('../services/journalManager');
const { log } = require('./logger');

const JOURNAL_REMINDER_MARKER = "💡 Don't forget to do your daily journal! Type 'journal' to start.";

// Pure(-ish) message processor: derives the bot's response from the
// inbound message + DB state, persists the turn, and returns the result.
// No outbound transport (Twilio / HTTP) — callers handle delivery.
//
// Returns: { response, urgencyLevel, context }
async function processMessage(from, message, profileName) {
  log.info(`Processing message from ${from}`, { profileName, message });

  const user = await userManager.getOrCreateUser(from, profileName);
  const userContext = userManager.getUserContext(user);

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
    response = await handleOnboarding(user, message, from);
    if (
      earlyDanger.urgencyLevel === 'high' ||
      earlyDanger.urgencyLevel === 'moderate'
    ) {
      response = `${earlyDanger.recommendedAction}\n\n${response}`;
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
      response = dangerSignAnalysis.recommendedAction;
      conversationContext = 'danger_sign_detected';
      if (symptoms.length > 0) {
        await db.saveSymptoms(from, symptoms, mood, dangerSignAnalysis.urgencyLevel);
      }
    } else if (dangerSignAnalysis.urgencyLevel === 'high') {
      response = dangerSignAnalysis.recommendedAction;
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
      });

      if (symptoms.length > 0) {
        await db.saveSymptoms(from, symptoms, mood, dangerSignAnalysis.urgencyLevel);
      }

      // Deterministic journal reminder (D19): append iff user hasn't
      // journaled today AND no recent bot turn already nudged them.
      const todaysJournal = await db.getTodaysJournal(from);
      if (!todaysJournal) {
        const remindedRecently = (conversationHistory || []).some(
          (turn) => turn.response && turn.response.includes(JOURNAL_REMINDER_MARKER)
        );
        if (!remindedRecently) {
          response += `\n\n${JOURNAL_REMINDER_MARKER}`;
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
      await sendWhatsAppMessage(
        from,
        "I apologize, but I'm having trouble processing your message. Please try again or type 'help' for assistance. If this is urgent, please contact your healthcare provider immediately."
      );
    } catch (sendError) {
      log.error('Failed to send error message', sendError);
    }
  }
}

// Marker phrase used to detect that the bot's most recent outbound was
// the name prompt — lets us treat the next inbound as the user's name
// without introducing a separate state column. (Phase 0 stays stateless;
// the proper state machine is Phase 1.)
const NAME_PROMPT_MARKER = "What's your name?";

const NAME_PROMPT = `Hello! 👋 I'm Amaaii, your pregnancy companion. I'm here to support you throughout your pregnancy journey.

${NAME_PROMPT_MARKER} You can call me by any name you're comfortable with.`;

async function handleOnboarding(user, message, phoneNumber) {
  if (!user.name) {
    const lastBot = await db.getLastBotMessage(phoneNumber);
    const previousWasNamePrompt =
      lastBot && lastBot.response && lastBot.response.includes(NAME_PROMPT_MARKER);
    if (previousWasNamePrompt) {
      const trimmedName = message.trim();
      if (trimmedName.length > 0) {
        await userManager.updateUserProfile(phoneNumber, { name: trimmedName });
        return `Thank you ${trimmedName}! 💚 To provide you with the best support, could you tell me your age?`;
      }
    }
    return NAME_PROMPT;
  }

  if (!user.age) {
    const ageMatch = message.match(/\d+/);
    if (ageMatch) {
      const age = parseInt(ageMatch[0]);
      await userManager.updateUserProfile(user.phone_number, { age });
      return `Thank you! How many weeks pregnant are you? (If you're not sure, you can tell me the date of your last period)`;
    }
    return `Thank you ${user.name}! 💚 To provide you with the best support, could you tell me your age?`;
  }

  if (!user.pregnancy_week) {
    const weeksMatch = message.match(/(\d+)\s*weeks?/i);
    const lmpMatch = message.match(/\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);

    if (weeksMatch) {
      const weeks = parseInt(weeksMatch[1]);
      const edd = calculateEDDFromWeeks(weeks);
      await userManager.updateUserProfile(user.phone_number, {
        pregnancy_week: weeks,
        edd,
      });
      return `Great! You're ${weeks} weeks along. 🤰

Where are you located? (This helps me suggest nearby health facilities when needed)`;
    } else if (lmpMatch) {
      const lmp = lmpMatch[0];
      const weeks = userManager.calculatePregnancyWeek(lmp);
      const edd = userManager.calculateEDD(lmp);
      await userManager.updateUserProfile(user.phone_number, {
        pregnancy_week: weeks,
        edd,
        lmp,
      });
      return `Based on your last period, you're about ${weeks} weeks pregnant. Your expected delivery date is around ${edd}.

Where are you located? (This helps me suggest nearby health facilities when needed)`;
    }

    return `How many weeks pregnant are you? You can also tell me the date of your last menstrual period (LMP) if you remember it.`;
  }

  if (!user.location) {
    await userManager.updateUserProfile(user.phone_number, { location: message });

    const summary = userManager.formatUserSummary(user);
    return `Perfect! I now have your basic information:
${summary}

You can:
• Share how you're feeling today
• Ask me any pregnancy questions
• Tell me about any symptoms you're experiencing
• Type "help" to see what I can do

How are you feeling today? 💚`;
  }

  return `Welcome back ${user.name}! How can I help you today?`;
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
