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
  SymptomHistoryEntry,
} from '@amaaii/core';

interface JournalResponseSuccess {
  response: string;
  nextStage?: JournalStage;
  completed: boolean;
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

  async startJournalSession(userPhone: string, _user: unknown): Promise<JournalSessionView> {
    // If there's an active session in the DB, resume it (e.g. after a
    // server restart mid-flow). Otherwise create a fresh journal row
    // and a new session pointing at it — this enables multi-checkin per
    // day: each `journal` command after a previous one completes opens
    // a brand-new row.
    const existingDbSession = await db.getJournalSession(userPhone);
    if (existingDbSession) {
      return {
        userPhone,
        currentStage: existingDbSession.currentStage,
        journalData: existingDbSession.journalData || {},
        journalId: existingDbSession.journalId,
      };
    }

    // INSERT the row up front so we capture started_at the moment the
    // user opens the check-in.
    const journalId = await db.createOrUpdateJournal(userPhone, {});

    const session: JournalSessionView = {
      userPhone,
      currentStage: 'greeting',
      journalData: {},
      journalId,
    };
    await db.upsertJournalSession(userPhone, {
      currentStage: session.currentStage,
      journalData: session.journalData,
      journalId,
    });
    return session;
  }

  async getJournalSession(userPhone: string): Promise<JournalSessionView | null> {
    const row = await db.getJournalSession(userPhone);
    if (!row) return null;
    return {
      userPhone,
      currentStage: row.currentStage,
      journalData: row.journalData || {},
      journalId: row.journalId,
    };
  }

  async processJournalResponse(
    userPhone: string,
    message: string,
    currentStage?: string
  ): Promise<JournalResponseResult> {
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
    const user = await db.getUser(userPhone);
    const pregnancyWeek = user?.pregnancy_week ?? 0;
    const lang = pickLang(user && user.language);

    let nextStage: JournalStage | undefined;
    // Initialized for strict definite-assignment; every case below
    // overwrites it exactly like the original (never actually observed
    // as '' — all 11 JournalStage values are handled below).
    let response = '';
    const journalUpdate: JournalPatch = {};

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
        let moodScore = coreExtractNumber(message);
        if (!(moodScore && moodScore >= 1 && moodScore <= 10)) {
          // Regex missed → ask the LLM to interpret.
          const out = await llm.extractMood(message);
          if (out && out.mood) moodScore = out.mood;
        }
        const moodValid = !!(moodScore && moodScore >= 1 && moodScore <= 10);
        nextStage = nextJournalStage(stage, { pregnancyWeek, moodValid });
        if (moodValid) {
          journalUpdate.emotional_state = moodScore as number;
          journalUpdate.mood_description = message;
          const ack =
            (moodScore as number) >= 7 ? t(lang, 'journal_mood_good') :
            (moodScore as number) >= 5 ? t(lang, 'journal_mood_ok') :
            t(lang, 'journal_mood_low');
          response = t(lang, 'journal_mood_followup', { ack });
        } else {
          response = t(lang, 'journal_mood_invalid');
        }
        break;
      }

      case 'symptoms': {
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
        const parsed = parseSleepAnswer(message);
        if (parsed.quality != null) journalUpdate.sleep_quality = parsed.quality;
        if (parsed.hours != null) journalUpdate.sleep_hours = parsed.hours;
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

        nextStage = nextJournalStage(stage, { pregnancyWeek });
        response = nextStage === 'baby_movement'
          ? t(lang, 'journal_baby_movement_q')
          : t(lang, 'journal_water_q');
        break;
      }

      case 'baby_movement': {
        let movementCount = coreExtractNumber(message);
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
        nextStage = nextJournalStage(stage, { pregnancyWeek });
        break;
      }

      case 'water': {
        let waterCount = coreExtractNumber(message);
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
        nextStage = nextJournalStage(stage, { pregnancyWeek });
        break;
      }

      case 'appetite': {
        let appetiteLevel: string | null = parseAppetiteAnswer(message);
        if (appetiteLevel === null) {
          const out = await llm.extractAppetite(message);
          if (out && out.appetite) appetiteLevel = out.appetite;
        }
        journalUpdate.appetite = appetiteLevel || 'moderate';
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

    if (Object.keys(journalUpdate).length > 0) {
      // All journal writes go to the SAME row created in
      // startJournalSession — multi-checkin works because each
      // `journal` command after a previous completion creates a fresh
      // row before processJournalResponse is ever called.
      await db.createOrUpdateJournal(userPhone, journalUpdate, journalId);
    }

    const mergedJournalData = { ...journalData, ...journalUpdate };

    if (nextStage === 'completed') {
      await db.deleteJournalSession(userPhone);
    } else {
      await db.upsertJournalSession(userPhone, {
        currentStage: nextStage as JournalStage,
        journalData: mergedJournalData,
        journalId,
      });
    }

    return { response, nextStage, completed: nextStage === 'completed' };
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

  isJournalCommand(message: string): boolean {
    const commands = [
      // EN
      'journal', 'daily check-in', 'check in', 'daily journal', 'start journal',
      // SW
      'jarida', 'anza jarida', 'jarida langu', 'ukaguzi wa kila siku',
    ];
    return commands.some((cmd) => message.toLowerCase().includes(cmd));
  }

  isSummaryCommand(message: string): boolean {
    const commands = ['journal summary', 'weekly summary', 'my progress', 'how am i doing'];
    return commands.some((cmd) => message.toLowerCase().includes(cmd));
  }

  isDoctorReportCommand(message: string): boolean {
    const commands = ['doctor report', 'generate report', 'medical summary'];
    return commands.some((cmd) => message.toLowerCase().includes(cmd));
  }
}

export = new JournalManager();
