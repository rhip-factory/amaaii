const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'amaaii.db');
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
        if (err) console.error('Error creating users table:', err);
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
        if (err) console.error('Error creating conversations table:', err);
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
        if (err) console.error('Error creating symptoms table:', err);
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
        if (err) console.error('Error creating anc_visits table:', err);
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
        if (err) console.error('Error creating journals table:', err);
        else resolve();
      });
    });
  });
}

async function createUser(phoneNumber, userData = {}) {
  return new Promise((resolve, reject) => {
    const { name, age, pregnancyWeek, edd, location, lmp } = userData;
    
    db.run(
      `INSERT OR REPLACE INTO users 
       (phone_number, name, age, pregnancy_week, edd, location, lmp, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [phoneNumber, name, age, pregnancyWeek, edd, location, lmp],
      function(err) {
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

async function updateUser(phoneNumber, updates) {
  const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
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
  saveSymptoms,
  scheduleANCVisit,
  getUpcomingANCVisits,
  markANCVisitAttended,
  createOrUpdateJournal,
  getTodaysJournal,
  getJournalHistory,
  getJournalAnalytics
};