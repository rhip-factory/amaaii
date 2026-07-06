// Thin CJS shim. The real implementation now lives in
// packages/adapters/src/sqlite/ (P1-C: repository pattern + SQLite
// adapter — see CLAUDE.md), built on interfaces declared in
// packages/core/src/repositories.ts. Kept as a same-named/same-shaped
// module — same 20 exports, same signatures — so every existing
// consumer (utils/messageHandler.js, utils/userManager.js,
// services/journalManager.js, services/trend.js, server.js, tests,
// scripts/smoke) keeps working unchanged.
//
// `tsx/cjs` registers Node module hooks that let a plain CommonJS
// `require()` load TypeScript sources — including their own internal
// relative imports across packages/*/src/*.ts — under vitest, tsx, and
// plain `node` alike. Safe/idempotent to call from multiple files; under
// `tsx server.js` it's a harmless no-op (tsx's hooks are already
// registered process-wide).
require('tsx/cjs');
const { createSqliteDatabaseAdapter } = require('../packages/adapters/src/index.ts');

// Single connection for the whole process, created at require time —
// same timing as the original module-level `db = new sqlite3.Database(...)`,
// so DB_PATH must still be set BEFORE this module is first required (see
// tests/*.test.js, which all set `process.env.DB_PATH = ':memory:'`
// ahead of `require('../services/database')`).
const adapter = createSqliteDatabaseAdapter();

// initializeDatabase is the one exception: the original module declared
// it as a plain function (not `async`), since it returns the
// db.serialize(...) Promise directly with no preceding logic that could
// throw synchronously.
function initializeDatabase() {
  return adapter.initialize();
}

// Every other export mirrors the original's `async function` declaration
// exactly (not just "returns a Promise") — e.g. updateUser's whitelist
// check throws synchronously, and only `async` turns that into a
// rejected Promise instead of an uncaught throw. See
// packages/adapters/src/sqlite/userRepository.ts for the actual check.
async function createUser(phoneNumber, userData = {}) {
  return adapter.users.createUser(phoneNumber, userData);
}

async function getUser(phoneNumber) {
  return adapter.users.getUser(phoneNumber);
}

async function updateUser(phoneNumber, updates) {
  return adapter.users.updateUser(phoneNumber, updates);
}

async function saveConversation(userPhone, message, response, analysis = {}) {
  return adapter.conversations.saveConversation(userPhone, message, response, analysis);
}

async function getConversationHistory(userPhone, limit = 10) {
  return adapter.conversations.getConversationHistory(userPhone, limit);
}

async function getLastBotMessage(userPhone) {
  return adapter.conversations.getLastBotMessage(userPhone);
}

async function getMedicalHistory(userPhone) {
  return adapter.medicalHistory.getMedicalHistory(userPhone);
}

async function saveMedicalHistory(userPhone, data) {
  return adapter.medicalHistory.saveMedicalHistory(userPhone, data);
}

async function getJournalSession(userPhone) {
  return adapter.journalSessions.getJournalSession(userPhone);
}

async function upsertJournalSession(userPhone, session) {
  return adapter.journalSessions.upsertJournalSession(userPhone, session);
}

async function deleteJournalSession(userPhone) {
  return adapter.journalSessions.deleteJournalSession(userPhone);
}

async function saveSymptoms(userPhone, symptoms, mood, urgency) {
  return adapter.symptoms.saveSymptoms(userPhone, symptoms, mood, urgency);
}

async function scheduleANCVisit(userPhone, scheduledDate, notes = '') {
  return adapter.ancVisits.scheduleANCVisit(userPhone, scheduledDate, notes);
}

async function getUpcomingANCVisits(userPhone) {
  return adapter.ancVisits.getUpcomingANCVisits(userPhone);
}

async function markANCVisitAttended(visitId) {
  return adapter.ancVisits.markANCVisitAttended(visitId);
}

async function createOrUpdateJournal(userPhone, journalData, journalId = null) {
  return adapter.journals.createOrUpdateJournal(userPhone, journalData, journalId);
}

async function getTodaysJournal(userPhone) {
  return adapter.journals.getTodaysJournal(userPhone);
}

async function getTodaysJournals(userPhone) {
  return adapter.journals.getTodaysJournals(userPhone);
}

async function getJournalHistory(userPhone, days = 7) {
  return adapter.journals.getJournalHistory(userPhone, days);
}

async function getJournalAnalytics(userPhone, days = 7) {
  return adapter.journals.getJournalAnalytics(userPhone, days);
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
