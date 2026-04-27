const db = require('./database');
const { detectDangerSigns, assessMood, extractSymptoms } = require('./dangerSigns');
const { t, pickLang } = require('./i18n');
const llm = require('./llmExtract');

function dangerCopy(level, lang) {
  if (level === 'critical') return t(lang, 'danger_critical');
  if (level === 'high') return t(lang, 'danger_high');
  if (level === 'moderate') return t(lang, 'danger_moderate');
  return '';
}

// Free-text journal stages (questions, notes) re-run symptom + danger
// detection so anything disclosed there isn't silently logged. Mutates
// `journalUpdate` (merges new symptoms, sets red_flags_detected) and
// returns a heads-up string to prepend to the bot's reply, or '' if
// nothing was found.
function scanFreeText(message, journalData, journalUpdate, lang = 'en') {
  const sx = extractSymptoms(message);
  const danger = detectDangerSigns(message);

  if (sx.length > 0) {
    const existing = (journalUpdate.physical_symptoms != null)
      ? journalUpdate.physical_symptoms
      : (journalData && journalData.physical_symptoms);
    let arr = [];
    if (typeof existing === 'string' && existing.trim().startsWith('[')) {
      try { const parsed = JSON.parse(existing); if (Array.isArray(parsed)) arr = parsed; } catch (_) {}
    }
    journalUpdate.physical_symptoms = JSON.stringify(Array.from(new Set([...arr, ...sx])));
  }

  if (danger.urgencyLevel === 'critical' || danger.urgencyLevel === 'high') {
    journalUpdate.red_flags_detected = JSON.stringify(danger.detectedSigns);
    return `${dangerCopy(danger.urgencyLevel, lang)}\n\n`;
  }
  if (sx.length > 0) {
    const niceList = sx.map((s) => s.replace(/_/g, ' ')).join(', ');
    return t(lang, 'heads_up_symptoms', { list: niceList });
  }
  return '';
}

function formatSymptoms(raw, lang = 'en') {
  if (!raw || raw === 'none') return t(lang, 'journal_no_symptoms');
  if (typeof raw !== 'string') return String(raw);
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((s) => String(s).replace(/_/g, ' ')).join(', ');
      }
    } catch (_) { /* fall through */ }
  }
  return trimmed;
}

class JournalManager {
  // Sessions are persisted to the journal_sessions table; this manager
  // is now stateless. (Phase 0 §7.5: drop in-memory Map so sessions
  // survive restarts.)

  async startJournalSession(userPhone, user) {
    const existingDbSession = await db.getJournalSession(userPhone);
    if (existingDbSession) {
      return {
        userPhone,
        currentStage: existingDbSession.currentStage,
        journalData: existingDbSession.journalData || {},
      };
    }

    const existingJournal = await db.getTodaysJournal(userPhone);
    const session = {
      userPhone,
      currentStage: existingJournal ? 'continue' : 'greeting',
      journalData: existingJournal || {},
    };

    await db.upsertJournalSession(userPhone, {
      currentStage: session.currentStage,
      journalData: session.journalData,
    });
    return session;
  }

  async getJournalSession(userPhone) {
    const row = await db.getJournalSession(userPhone);
    if (!row) return null;
    return {
      userPhone,
      currentStage: row.currentStage,
      journalData: row.journalData || {},
    };
  }

  async processJournalResponse(userPhone, message, currentStage) {
    const dbSession = await db.getJournalSession(userPhone);
    if (!dbSession) {
      return { error: true, message: 'No active journal session' };
    }
    const stage = currentStage || dbSession.currentStage;
    const journalData = dbSession.journalData || {};
    const user = await db.getUser(userPhone);
    const pregnancyWeek = (user && user.pregnancy_week) || 0;
    const lang = pickLang(user && user.language);

    let nextStage;
    let response;
    const journalUpdate = {};

    switch (stage) {
      case 'greeting':
        nextStage = 'mood';
        response = t(lang, 'journal_greeting');
        break;

      case 'continue':
        nextStage = 'mood';
        response = t(lang, 'journal_continue');
        break;

      case 'mood': {
        let moodScore = this.extractNumber(message);
        if (!(moodScore && moodScore >= 1 && moodScore <= 10)) {
          // Regex missed → ask the LLM to interpret.
          const out = await llm.extractMood(message);
          if (out && out.mood) moodScore = out.mood;
        }
        if (moodScore && moodScore >= 1 && moodScore <= 10) {
          journalUpdate.emotional_state = moodScore;
          journalUpdate.mood_description = message;
          nextStage = 'symptoms';
          const ack =
            moodScore >= 7 ? t(lang, 'journal_mood_good') :
            moodScore >= 5 ? t(lang, 'journal_mood_ok') :
            t(lang, 'journal_mood_low');
          response = t(lang, 'journal_mood_followup', { ack });
        } else {
          nextStage = 'mood';
          response = t(lang, 'journal_mood_invalid');
        }
        break;
      }

      case 'symptoms': {
        const symptoms = extractSymptoms(message);
        const dangerAnalysis = detectDangerSigns(message);

        // Accept "none" in EN or "hapana" in SW as the no-symptoms sentinel.
        const lower = message.toLowerCase();
        const isNone = lower.includes('none') || lower.includes('hapana');
        journalUpdate.physical_symptoms =
          symptoms.length > 0 ? JSON.stringify(symptoms) :
          isNone ? 'none' : message;

        if (dangerAnalysis.urgencyLevel === 'critical' || dangerAnalysis.urgencyLevel === 'high') {
          journalUpdate.red_flags_detected = JSON.stringify(dangerAnalysis.detectedSigns);
          response = `${dangerCopy(dangerAnalysis.urgencyLevel, lang)}\n\n${t(lang, 'journal_pause')}`;
          nextStage = 'completed';
        } else {
          nextStage = 'sleep';
          response = t(lang, 'journal_symptoms_noted');
        }
        break;
      }

      case 'sleep': {
        const qualityMatch =
          message.match(/(\d+)\s*(?:\/|out of)\s*10/i) ||
          message.match(/\b(\d+)\s+for\s+sleep\b/i) ||
          message.match(/\bsleep(?:\s+(?:was|is))?(?:\s+(?:a|an))?\s+(\d+)\b/i);
        const hoursMatch = message.match(/(\d+(?:\.\d+)?)\s*(?:h(?:ours?|rs?)?\b)/i);

        if (qualityMatch) {
          const q = parseInt(qualityMatch[1], 10);
          if (q >= 1 && q <= 10) journalUpdate.sleep_quality = q;
        }
        if (hoursMatch) {
          journalUpdate.sleep_hours = parseFloat(hoursMatch[1]);
        }
        // LLM fallback if either signal is missing — covers phrasings
        // like "really bad, only 3 hours" or Kiswahili input.
        if (journalUpdate.sleep_quality == null || journalUpdate.sleep_hours == null) {
          const out = await llm.extractSleep(message);
          if (out) {
            if (journalUpdate.sleep_quality == null && out.quality != null) {
              journalUpdate.sleep_quality = out.quality;
            }
            if (journalUpdate.sleep_hours == null && out.hours != null) {
              journalUpdate.sleep_hours = out.hours;
            }
          }
        }

        nextStage = pregnancyWeek >= 20 ? 'baby_movement' : 'water';
        response = pregnancyWeek >= 20
          ? t(lang, 'journal_baby_movement_q')
          : t(lang, 'journal_water_q');
        break;
      }

      case 'baby_movement': {
        let movementCount = this.extractNumber(message);
        if (movementCount === null) {
          const out = await llm.extractMovement(message);
          if (out && out.count != null) movementCount = out.count;
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
        nextStage = 'water';
        break;
      }

      case 'water': {
        let waterCount = this.extractNumber(message);
        if (waterCount === null) {
          const out = await llm.extractWater(message);
          if (out && out.glasses != null) waterCount = out.glasses;
        }
        if (waterCount !== null) {
          journalUpdate.water_intake = waterCount;
          const ack =
            waterCount >= 8 ? t(lang, 'journal_water_great') :
            waterCount >= 6 ? t(lang, 'journal_water_ok') :
            t(lang, 'journal_water_low');
          response = t(lang, 'journal_water_followup', { ack });
        } else {
          response = t(lang, 'journal_water_invalid');
        }
        nextStage = 'appetite';
        break;
      }

      case 'appetite': {
        // Priority ladder. Recognise EN + SW words: "nzuri" (good),
        // "wastani" (moderate), "mbaya"/"hapana" (poor).
        const lower = message.toLowerCase();
        let appetiteLevel = null;
        let regexHit = false;
        if (/\bpoor\b/.test(lower) || /\bno appetite\b/.test(lower) || /\bno good appetite\b/.test(lower) || /\bmbaya\b/.test(lower)) {
          appetiteLevel = 'poor'; regexHit = true;
        } else if (/\bgood\b/.test(lower) || /\bgreat\b/.test(lower) || /\bnzuri\b/.test(lower)) {
          appetiteLevel = 'good'; regexHit = true;
        } else if (/\bmoderate\b/.test(lower) || /\bok(?:ay)?\b/.test(lower) || /\bwastani\b/.test(lower)) {
          appetiteLevel = 'moderate'; regexHit = true;
        }
        if (/\bnot\s+poor\b/.test(lower) || /\bsi\s+mbaya\b/.test(lower)) {
          appetiteLevel = 'moderate'; regexHit = true;
        }
        if (!regexHit) {
          const out = await llm.extractAppetite(message);
          if (out && out.appetite) appetiteLevel = out.appetite;
        }
        journalUpdate.appetite = appetiteLevel || 'moderate';
        nextStage = 'questions';
        response = t(lang, 'journal_questions_q');
        break;
      }

      case 'questions': {
        const lower = message.toLowerCase().trim();
        const isSkipping = lower === 'none' || lower === 'hapana';
        let questionsHeadsUp = '';
        if (!isSkipping) {
          journalUpdate.questions_for_doctor = message;
          questionsHeadsUp = scanFreeText(message, journalData, journalUpdate, lang);
        }
        nextStage = 'notes';
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
          noteHeadsUp = scanFreeText(message, journalData, journalUpdate, lang);
        }
        journalUpdate.completed = 1;
        nextStage = 'completed';
        const summary = await this.generateJournalSummary(journalData, journalUpdate, lang);
        response = noteHeadsUp + summary;
        break;
      }

      case 'completed':
        response = t(lang, 'journal_done');
        break;
    }

    if (Object.keys(journalUpdate).length > 0) {
      await db.createOrUpdateJournal(userPhone, journalUpdate);
    }

    const mergedJournalData = { ...journalData, ...journalUpdate };

    if (nextStage === 'completed') {
      await db.deleteJournalSession(userPhone);
    } else {
      await db.upsertJournalSession(userPhone, {
        currentStage: nextStage,
        journalData: mergedJournalData,
      });
    }

    return { response, nextStage, completed: nextStage === 'completed' };
  }

  async generateJournalSummary(existingData, newData, lang = 'en') {
    const data = { ...existingData, ...newData };
    let summary = t(lang, 'journal_summary_title');

    if (data.emotional_state) {
      const moodEmoji = data.emotional_state >= 7 ? '😊' :
                       data.emotional_state >= 5 ? '😐' : '😔';
      summary += `${t(lang, 'journal_summary_mood')} ${data.emotional_state}/10 ${moodEmoji}\n`;
    }

    if (data.physical_symptoms) {
      summary += `${t(lang, 'journal_summary_symptoms')} ${formatSymptoms(data.physical_symptoms, lang)}\n`;
    }

    if (data.sleep_quality || data.sleep_hours) {
      const parts = [];
      if (data.sleep_quality) parts.push(`${data.sleep_quality}${t(lang, 'journal_summary_quality')}`);
      if (data.sleep_hours) parts.push(`${data.sleep_hours} ${t(lang, 'journal_summary_hours')}`);
      summary += `${t(lang, 'journal_summary_sleep')} ${parts.join(', ')}\n`;
    }

    if (data.baby_movement_count !== undefined && data.baby_movement_count !== null) {
      const movementStatus = data.baby_movement_count >= 10 ? '✅' : '⚠️';
      summary += `${t(lang, 'journal_summary_movement')} ${data.baby_movement_count} ${t(lang, 'journal_summary_movement_unit')} ${movementStatus}\n`;
    }

    if (data.water_intake) {
      const waterStatus = data.water_intake >= 8 ? '✅' : '💧';
      summary += `${t(lang, 'journal_summary_water')} ${data.water_intake} ${t(lang, 'journal_summary_water_unit')} ${waterStatus}\n`;
    }

    if (data.appetite) {
      summary += `${t(lang, 'journal_summary_appetite')} ${data.appetite}\n`;
    }

    summary += '\n';

    if (data.red_flags_detected) {
      summary += t(lang, 'journal_summary_red_flag');
    }

    const recommendations = this.generateRecommendations(data, lang);
    if (recommendations.length > 0) {
      summary += t(lang, 'journal_summary_recs');
      recommendations.forEach((rec) => (summary += `• ${rec}\n`));
    }

    summary += t(lang, 'journal_summary_done');
    return summary;
  }

  generateRecommendations(data, lang = 'en') {
    const recommendations = [];
    if (data.emotional_state < 5) {
      recommendations.push(t(lang, 'rec_mood_low'));
    }
    if (data.sleep_hours && data.sleep_hours < 6) {
      recommendations.push(t(lang, 'rec_sleep'));
    }
    if (data.water_intake && data.water_intake < 8) {
      recommendations.push(t(lang, 'rec_water'));
    }
    if (data.appetite === 'poor') {
      recommendations.push(t(lang, 'rec_appetite_poor'));
    }
    if (data.baby_movement_count !== undefined && data.baby_movement_count < 10) {
      recommendations.push(t(lang, 'rec_movement'));
    }
    return recommendations;
  }

  async getWeeklySummary(userPhone) {
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

  extractWeeklySymptoms(history) {
    const symptomCount = {};
    history.forEach((entry) => {
      if (!entry.physical_symptoms || entry.physical_symptoms === 'none') return;
      // Only attempt JSON.parse when the value is actually a JSON array
      // payload. Free-text user input is ignored rather than silently
      // swallowed by a try/catch. (D10.)
      const value = entry.physical_symptoms.trim();
      if (!value.startsWith('[')) return;
      const symptoms = JSON.parse(value);
      if (!Array.isArray(symptoms)) return;
      symptoms.forEach((symptom) => {
        symptomCount[symptom] = (symptomCount[symptom] || 0) + 1;
      });
    });

    return Object.entries(symptomCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([symptom]) => symptom);
  }

  generateWeeklyInsights(analytics, history) {
    let insights = '\n💡 **Insights:**\n';
    if (analytics.avg_mood >= 7) {
      insights += "• You've had a positive week emotionally! 🌟\n";
    } else if (analytics.avg_mood < 5) {
      insights += '• Your mood has been low. Consider reaching out for support. 💚\n';
    }
    if (analytics.avg_water >= 8) {
      insights += '• Great hydration this week! Keep it up! 💧\n';
    } else {
      insights += '• Try to increase your water intake. 💧\n';
    }
    if (analytics.journal_count >= 6) {
      insights += '• Excellent journaling consistency! 📝\n';
    } else if (analytics.journal_count < 3) {
      insights += '• Try to journal more regularly to track your journey. 📝\n';
    }
    return insights;
  }

  async generateDoctorReport(userPhone, days = 30) {
    const history = await db.getJournalHistory(userPhone, days);
    const user = await db.getUser(userPhone);

    let report = `**Pregnancy Health Report**\n`;
    report += `Patient: ${user.name || 'Not provided'}\n`;
    report += `Age: ${user.age || 'Not provided'}\n`;
    report += `Current Week: ${user.pregnancy_week || 'Not provided'}\n`;
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

  extractNumber(message) {
    const match = message.match(/\d+/);
    return match ? parseInt(match[0]) : null;
  }

  isJournalCommand(message) {
    const commands = ['journal', 'daily check-in', 'check in', 'daily journal', 'start journal'];
    return commands.some((cmd) => message.toLowerCase().includes(cmd));
  }

  isSummaryCommand(message) {
    const commands = ['journal summary', 'weekly summary', 'my progress', 'how am i doing'];
    return commands.some((cmd) => message.toLowerCase().includes(cmd));
  }

  isDoctorReportCommand(message) {
    const commands = ['doctor report', 'generate report', 'medical summary'];
    return commands.some((cmd) => message.toLowerCase().includes(cmd));
  }
}

module.exports = new JournalManager();
