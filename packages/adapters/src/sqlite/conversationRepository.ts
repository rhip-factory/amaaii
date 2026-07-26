// Ported 1:1 from services/database.js — saveConversation,
// getConversationHistory, getLastBotMessage.

import type sqlite3 from 'sqlite3';
import type {
  ConversationAnalysis,
  ConversationRepository,
  ConversationRow,
  LastBotMessageRow,
} from '@amaaii/core';

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly db: sqlite3.Database) {}

  saveConversation(
    userPhone: string,
    message: string,
    response: string,
    analysis: ConversationAnalysis = {}
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const { dangerSigns, urgencyLevel, context } = analysis;

      this.db.run(
        `INSERT INTO conversations
         (user_phone, message, response, danger_signs_detected, urgency_level, context)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          userPhone,
          message,
          response,
          JSON.stringify(dangerSigns || []),
          urgencyLevel,
          context,
        ],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  getConversationHistory(userPhone: string, limit = 10): Promise<ConversationRow[]> {
    return new Promise((resolve, reject) => {
      // `timestamp` is SQLite's CURRENT_TIMESTAMP, which only has
      // 1-second resolution — a fast sequence of turns (e.g. the P3-B
      // consent gate exchanging 2-3 messages with a user inside the same
      // wall-clock second) can tie. `id DESC` breaks the tie in favor of
      // the more-recently-INSERTed row (id is an AUTOINCREMENT primary
      // key), which is always what "most recent" means here regardless
      // of what the coarse timestamp says.
      this.db.all<ConversationRow>(
        `SELECT * FROM conversations
         WHERE user_phone = ?
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`,
        [userPhone, limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // P3-C data-portability export — ALL rows, oldest first (no LIMIT).
  getAllForUser(userPhone: string): Promise<ConversationRow[]> {
    return new Promise((resolve, reject) => {
      this.db.all<ConversationRow>(
        `SELECT * FROM conversations
         WHERE user_phone = ?
         ORDER BY timestamp ASC, id ASC`,
        [userPhone],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  getLastBotMessage(userPhone: string): Promise<LastBotMessageRow | null> {
    return new Promise((resolve, reject) => {
      // Same tie-breaking rationale as getConversationHistory above —
      // this is the query the stateless onboarding/consent-gate
      // "was the bot's last message X?" detection depends on
      // (messageHandler.ts's NAME_PROMPT_MARKERS / CONSENT_PROMPT_MARKERS
      // / WEEK_REPROMPT_MARKERS checks), so returning a stale row on a
      // same-second tie silently breaks that detection.
      this.db.get<LastBotMessageRow>(
        `SELECT response, context FROM conversations
         WHERE user_phone = ?
         ORDER BY timestamp DESC, id DESC
         LIMIT 1`,
        [userPhone],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        }
      );
    });
  }
}
