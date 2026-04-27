const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { log } = require('../utils/logger');

// Tests can override via DB_PATH=":memory:" for an isolated in-memory DB.
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'amaaii.db');
const db = new sqlite3.Database(dbPath);

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          phone_number TEXT PRIMARY KEY,
          name TEXT,
          age INTEGER,
          pregnancy_week INTEGER,
          edd DATE,
          location TEXT,
          risk_level TEXT DEFAULT 'low',
          lmp DATE,
          anc_visits INTEGER DEFAULT 0,
          language TEXT DEFAULT 'en',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) log.error("Error creating users table", err);
      });

      // Idempotent migration: add language column on existing DBs.
      // PRAGMA-based check avoids the "duplicate column" error from a
      // bare ALTER TABLE on a fresh schema.
      db.all(`PRAGMA table_info(users)`, (err, rows) => {
        if (err) return;
        const hasLanguage = (rows || []).some((r) => r.name === 'language');
        if (!hasLanguage) {
          db.run(`ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'en'`, (e) => {
            if (e) log.error("Error adding users.language column", e);
          });
        }
      });

      db.run(`
        CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_phone TEXT NOT NULL,
          message TEXT,
          response TEXT,
          danger_signs_detected TEXT,
          urgency_level TEXT,
          context TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `, (err) => {
        if (err) log.error("Error creating conversations table", err);
      });

      db.run(`
        CREATE TABLE IF NOT EXISTS symptoms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_phone TEXT NOT NULL,
          symptoms TEXT,
          mood TEXT,
          urgency TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `, (err) => {
        if (err) log.error("Error creating symptoms table", err);
      });

      db.run(`
        CREATE TABLE IF NOT EXISTS anc_visits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_phone TEXT NOT NULL,
          scheduled_date DATE,
          attended BOOLEAN DEFAULT 0,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `, (err) => {
        if (err) log.error("Error creating anc_visits table", err);
      });

      db.run(`
        CREATE TABLE IF NOT EXISTS journals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_phone TEXT NOT NULL,
          date DATE DEFAULT (date('now')),
          journal_stage TEXT,
          physical_symptoms TEXT,
          emotional_state INTEGER,
          mood_description TEXT,
          energy_level INTEGER,
          sleep_quality INTEGER,
          sleep_hours REAL,
          appetite TEXT,
          baby_movement_count INTEGER,
          baby_movement_time TEXT,
          water_intake INTEGER,
          medications_taken TEXT,
          questions_for_doctor TEXT,
          special_notes TEXT,
          red_flags_detected TEXT,
          completed BOOLEAN DEFAULT 0,
          started_at DATETIME,
          completed_at DATETIME,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `, (err) => {
        if (err) log.error("Error creating journals table", err);
      });

      // Idempotent migration for journals.started_at / completed_at on
      // existing DBs. PRAGMA-based check avoids the "duplicate column"
      // error from a bare ALTER TABLE on a fresh schema.
      db.all(`PRAGMA table_info(journals)`, (err, rows) => {
        if (err) return;
        const have = new Set((rows || []).map((r) => r.name));
        if (!have.has('started_at')) {
          db.run(`ALTER TABLE journals ADD COLUMN started_at DATETIME`, (e) => {
            if (e) log.error('Error adding journals.started_at', e);
          });
        }
        if (!have.has('completed_at')) {
          db.run(`ALTER TABLE journals ADD COLUMN completed_at DATETIME`, (e) => {
            if (e) log.error('Error adding journals.completed_at', e);
          });
        }
      });

      db.run(`
        CREATE TABLE IF NOT EXISTS journal_sessions (
          user_phone TEXT PRIMARY KEY,
          current_stage TEXT NOT NULL,
          journal_data TEXT NOT NULL,
          journal_id INTEGER,
          channel TEXT NOT NULL DEFAULT 'whatsapp',
          started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number),
          FOREIGN KEY (journal_id) REFERENCES journals(id)
        )
      `, (err) => {
        if (err) log.error("Error creating journal_sessions table", err);
      });

      // Idempotent migration: journal_sessions.journal_id on older DBs.
      db.all(`PRAGMA table_info(journal_sessions)`, (err, rows) => {
        if (err) return;
        const have = new Set((rows || []).map((r) => r.name));
        if (!have.has('journal_id')) {
          db.run(`ALTER TABLE journal_sessions ADD COLUMN journal_id INTEGER`, (e) => {
            if (e) log.error('Error adding journal_sessions.journal_id', e);
          });
        }
      });

      // Medical history (Phase D). 1:1 with users. raw_text is the
      // narrative the user typed; extracted_json is the LLM-structured
      // version (gravida/parity/conditions/etc.) for downstream use.
      db.run(`
        CREATE TABLE IF NOT EXISTS medical_history (
          user_phone TEXT PRIMARY KEY,
          raw_text TEXT,
          extracted_json TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `, (err) => {
        if (err) log.error("Error creating medical_history table", err);
      });

      db.run(
        `CREATE INDEX IF NOT EXISTS idx_journal_sessions_updated
         ON journal_sessions(updated_at)`,
        (err) => {
          if (err) log.error("Error creating journal_sessions index", err);
          else resolve();
        }
      );
    });
  });
}

// userData keys that can be persisted (UI / Twilio occasionally sends
// `pregnancyWeek` camelCase — we map it to the snake_case column).
const USER_FIELD_MAP = {
  name: 'name',
  age: 'age',
  pregnancyWeek: 'pregnancy_week',
  pregnancy_week: 'pregnancy_week',
  edd: 'edd',
  location: 'location',
  lmp: 'lmp',
  risk_level: 'risk_level',
  anc_visits: 'anc_visits',
  language: 'language',
};

async function createUser(phoneNumber, userData = {}) {
  // D15: don't INSERT OR REPLACE — that nulls out columns we didn't pass.
  // If the row exists, UPDATE only the provided fields; otherwise INSERT.
  const existing = await getUser(phoneNumber);
  if (existing) {
    const updates = {};
    for (const [k, v] of Object.entries(userData)) {
      const col = USER_FIELD_MAP[k];
      if (col && v !== undefined) updates[col] = v;
    }
    if (Object.keys(updates).length > 0) {
      await updateUser(phoneNumber, updates);
    }
    return existing.rowid || null;
  }

  return new Promise((resolve, reject) => {
    const { name, age, pregnancyWeek, pregnancy_week, edd, location, lmp } = userData;
    const week = pregnancyWeek != null ? pregnancyWeek : pregnancy_week;
    db.run(
      `INSERT INTO users
         (phone_number, name, age, pregnancy_week, edd, location, lmp, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [phoneNumber, name, age, week, edd, location, lmp],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

async function getUser(phoneNumber) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM users WHERE phone_number = ?',
      [phoneNumber],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

// D14: defense in depth — reject unknown columns at the DB layer too.
// The only allowed targets are real users-table columns. Aside from the
// safety win, this means SQL identifiers can never be user-controlled.
const UPDATE_USER_ALLOWED = new Set([
  'name', 'age', 'pregnancy_week', 'edd',
  'location', 'lmp', 'risk_level', 'anc_visits',
  'language',
]);

async function updateUser(phoneNumber, updates) {
  const keys = Object.keys(updates);
  for (const key of keys) {
    if (!UPDATE_USER_ALLOWED.has(key)) {
      throw new Error(`updateUser: rejected non-whitelisted key "${key}"`);
    }
  }
  const fields = keys.map((key) => `${key} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(phoneNumber);
  
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE users SET ${fields}, updated_at = datetime('now') WHERE phone_number = ?`,
      values,
      function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

async function saveConversation(userPhone, message, response, analysis = {}) {
  return new Promise((resolve, reject) => {
    const { dangerSigns, urgencyLevel, context } = analysis;
    
    db.run(
      `INSERT INTO conversations 
       (user_phone, message, response, danger_signs_detected, urgency_level, context) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userPhone,
        message,
        response,
        JSON.stringify(dangerSigns || []),
        urgencyLevel,
        context
      ],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

async function getConversationHistory(userPhone, limit = 10) {
  return new Promise((resolve, reject) => {
    db.all(
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

async function getJournalSession(userPhone) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT current_stage, journal_data, journal_id, channel, started_at, updated_at
       FROM journal_sessions WHERE user_phone = ?`,
      [userPhone],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        let parsed;
        try {
          parsed = JSON.parse(row.journal_data);
        } catch (e) {
          return reject(new Error(`journal_data not valid JSON for ${userPhone}: ${e.message}`));
        }
        resolve({
          currentStage: row.current_stage,
          journalData: parsed,
          journalId: row.journal_id || null,
          channel: row.channel,
          startedAt: row.started_at,
          updatedAt: row.updated_at,
        });
      }
    );
  });
}

async function upsertJournalSession(userPhone, { currentStage, journalData, journalId = null, channel = 'whatsapp' }) {
  const payload = JSON.stringify(journalData || {});
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO journal_sessions
         (user_phone, current_stage, journal_data, journal_id, channel, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_phone) DO UPDATE SET
         current_stage = excluded.current_stage,
         journal_data  = excluded.journal_data,
         journal_id    = excluded.journal_id,
         channel       = excluded.channel,
         updated_at    = datetime('now')`,
      [userPhone, currentStage, payload, journalId, channel],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

async function deleteJournalSession(userPhone) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM journal_sessions WHERE user_phone = ?`,
      [userPhone],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

async function getMedicalHistory(userPhone) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT raw_text, extracted_json, updated_at FROM medical_history WHERE user_phone = ?`,
      [userPhone],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        let parsed = null;
        if (row.extracted_json) {
          try { parsed = JSON.parse(row.extracted_json); } catch (_) { /* ignore */ }
        }
        resolve({ rawText: row.raw_text, ...(parsed || {}), updatedAt: row.updated_at });
      }
    );
  });
}

async function saveMedicalHistory(userPhone, { rawText, extracted }) {
  const json = JSON.stringify(extracted || {});
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO medical_history (user_phone, raw_text, extracted_json, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_phone) DO UPDATE SET
         raw_text = excluded.raw_text,
         extracted_json = excluded.extracted_json,
         updated_at = datetime('now')`,
      [userPhone, rawText || null, json],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

async function getLastBotMessage(userPhone) {
  return new Promise((resolve, reject) => {
    db.get(
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

async function saveSymptoms(userPhone, symptoms, mood, urgency) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO symptoms (user_phone, symptoms, mood, urgency) VALUES (?, ?, ?, ?)`,
      [userPhone, JSON.stringify(symptoms), mood, urgency],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

async function scheduleANCVisit(userPhone, scheduledDate, notes = '') {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO anc_visits (user_phone, scheduled_date, notes) VALUES (?, ?, ?)`,
      [userPhone, scheduledDate, notes],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

async function getUpcomingANCVisits(userPhone) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM anc_visits 
       WHERE user_phone = ? AND attended = 0 AND scheduled_date >= date('now')
       ORDER BY scheduled_date ASC`,
      [userPhone],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

async function markANCVisitAttended(visitId) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE anc_visits SET attended = 1 WHERE id = ?',
      [visitId],
      function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

// Whitelisted journal columns. SQL identifiers are never user-controlled.
const JOURNAL_COLUMNS = new Set([
  'journal_stage', 'physical_symptoms', 'emotional_state', 'mood_description',
  'energy_level', 'sleep_quality', 'sleep_hours', 'appetite',
  'baby_movement_count', 'baby_movement_time', 'water_intake',
  'medications_taken', 'questions_for_doctor', 'special_notes',
  'red_flags_detected', 'completed', 'started_at', 'completed_at',
]);

// Insert a NEW journal row OR update an existing one by id. Multi-checkin
// support: passing journalId=null always inserts a fresh row, so users
// can complete several check-ins per day. journalManager owns the id
// after startJournalSession() and threads it through every stage update.
async function createOrUpdateJournal(userPhone, journalData, journalId = null) {
  // Strip any keys that aren't whitelisted columns. Defense in depth —
  // the only writer is journalManager which controls its own keys, but
  // this protects against future regressions.
  const safe = {};
  for (const [k, v] of Object.entries(journalData || {})) {
    if (JOURNAL_COLUMNS.has(k)) safe[k] = v;
  }

  return new Promise((resolve, reject) => {
    if (journalId) {
      const fields = Object.keys(safe);
      if (fields.length === 0) return resolve(journalId);
      const setClause = fields.map((f) => `${f} = ?`).join(', ');
      const values = fields.map((f) => safe[f]);
      values.push(journalId);
      db.run(
        `UPDATE journals SET ${setClause} WHERE id = ?`,
        values,
        function (err) {
          if (err) reject(err);
          else resolve(journalId);
        }
      );
    } else {
      // Fresh check-in — record start time even if journalData is empty.
      const fields = ['user_phone', 'started_at', ...Object.keys(safe)];
      const placeholders = fields.map(() => '?').join(', ');
      const values = [userPhone, new Date().toISOString(), ...Object.values(safe)];
      db.run(
        `INSERT INTO journals (${fields.join(', ')}) VALUES (${placeholders})`,
        values,
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    }
  });
}

// Returns the most recent journal row for today (could be in-progress
// or completed). With multi-checkin, "today's journal" means "the one
// the user is working on or just finished".
async function getTodaysJournal(userPhone) {
  return new Promise((resolve, reject) => {
    const today = new Date().toISOString().split('T')[0];
    db.get(
      `SELECT * FROM journals
       WHERE user_phone = ? AND date = ?
       ORDER BY COALESCE(started_at, timestamp) DESC, id DESC
       LIMIT 1`,
      [userPhone, today],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

// All journals for today, oldest first.
async function getTodaysJournals(userPhone) {
  return new Promise((resolve, reject) => {
    const today = new Date().toISOString().split('T')[0];
    db.all(
      `SELECT * FROM journals
       WHERE user_phone = ? AND date = ?
       ORDER BY COALESCE(started_at, timestamp) ASC, id ASC`,
      [userPhone, today],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

async function getJournalHistory(userPhone, days = 7) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM journals 
       WHERE user_phone = ? 
       AND date >= date('now', '-' || ? || ' days')
       ORDER BY date DESC`,
      [userPhone, days],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

async function getJournalAnalytics(userPhone, days = 7) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT 
        AVG(emotional_state) as avg_mood,
        AVG(energy_level) as avg_energy,
        AVG(sleep_quality) as avg_sleep,
        AVG(water_intake) as avg_water,
        COUNT(*) as journal_count,
        SUM(CASE WHEN red_flags_detected IS NOT NULL THEN 1 ELSE 0 END) as red_flag_days
       FROM journals 
       WHERE user_phone = ? 
       AND date >= date('now', '-' || ? || ' days')`,
      [userPhone, days],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

module.exports = {
  initializeDatabase,
  createUser,
  getUser,
  updateUser,
  saveConversation,
  getConversationHistory,
  getLastBotMessage,
  getMedicalHistory,
  saveMedicalHistory,
  getJournalSession,
  upsertJournalSession,
  deleteJournalSession,
  saveSymptoms,
  scheduleANCVisit,
  getUpcomingANCVisits,
  markANCVisitAttended,
  createOrUpdateJournal,
  getTodaysJournal,
  getTodaysJournals,
  getJournalHistory,
  getJournalAnalytics
};