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
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) log.error("Error creating users table", err);
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
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `, (err) => {
        if (err) log.error("Error creating journals table", err);
      });

      db.run(`
        CREATE TABLE IF NOT EXISTS journal_sessions (
          user_phone TEXT PRIMARY KEY,
          current_stage TEXT NOT NULL,
          journal_data TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'whatsapp',
          started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_phone) REFERENCES users(phone_number)
        )
      `, (err) => {
        if (err) log.error("Error creating journal_sessions table", err);
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
      `SELECT current_stage, journal_data, channel, started_at, updated_at
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
          channel: row.channel,
          startedAt: row.started_at,
          updatedAt: row.updated_at,
        });
      }
    );
  });
}

async function upsertJournalSession(userPhone, { currentStage, journalData, channel = 'whatsapp' }) {
  const payload = JSON.stringify(journalData || {});
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO journal_sessions
         (user_phone, current_stage, journal_data, channel, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_phone) DO UPDATE SET
         current_stage = excluded.current_stage,
         journal_data  = excluded.journal_data,
         channel       = excluded.channel,
         updated_at    = datetime('now')`,
      [userPhone, currentStage, payload, channel],
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

async function createOrUpdateJournal(userPhone, journalData) {
  return new Promise((resolve, reject) => {
    const today = new Date().toISOString().split('T')[0];
    
    db.get(
      'SELECT id FROM journals WHERE user_phone = ? AND date = ?',
      [userPhone, today],
      (err, existingJournal) => {
        if (err) {
          reject(err);
          return;
        }
        
        if (existingJournal) {
          const fields = Object.keys(journalData).map(key => `${key} = ?`).join(', ');
          const values = Object.values(journalData);
          values.push(existingJournal.id);
          
          db.run(
            `UPDATE journals SET ${fields} WHERE id = ?`,
            values,
            function(err) {
              if (err) reject(err);
              else resolve(existingJournal.id);
            }
          );
        } else {
          const fields = Object.keys(journalData);
          fields.push('user_phone');
          const placeholders = fields.map(() => '?').join(', ');
          const values = Object.values(journalData);
          values.push(userPhone);
          
          db.run(
            `INSERT INTO journals (${fields.join(', ')}) VALUES (${placeholders})`,
            values,
            function(err) {
              if (err) reject(err);
              else resolve(this.lastID);
            }
          );
        }
      }
    );
  });
}

async function getTodaysJournal(userPhone) {
  return new Promise((resolve, reject) => {
    const today = new Date().toISOString().split('T')[0];
    
    db.get(
      'SELECT * FROM journals WHERE user_phone = ? AND date = ?',
      [userPhone, today],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
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
  getJournalSession,
  upsertJournalSession,
  deleteJournalSession,
  saveSymptoms,
  scheduleANCVisit,
  getUpcomingANCVisits,
  markANCVisitAttended,
  createOrUpdateJournal,
  getTodaysJournal,
  getJournalHistory,
  getJournalAnalytics
};