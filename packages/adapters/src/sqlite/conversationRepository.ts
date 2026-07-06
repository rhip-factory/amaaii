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
      this.db.all<ConversationRow>(
        `SELECT * FROM conversations
         WHERE user_phone = ?
         ORDER BY timestamp DESC
         LIMIT ?`,
        [userPhone, limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  getLastBotMessage(userPhone: string): Promise<LastBotMessageRow | null> {
    return new Promise((resolve, reject) => {
      this.db.get<LastBotMessageRow>(
        `SELECT response, context FROM conversations
         WHERE user_phone = ?
         ORDER BY timestamp DESC
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
