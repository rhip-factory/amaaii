// P1-E: entry point — ported 1:1 from server.js (final step of the TS
// migration; see CLAUDE.md). Owns env loading, DB init, and
// app.listen(); all routes/middleware live in ./app (createApp).
//
// Import order here is load-bearing:
//  1. `./register-paths` MUST be first — it patches Node's module
//     resolver so compiled `dist/` output can find `@amaaii/core` /
//     `@amaaii/adapters` (see that file's header for the full dist-boot
//     writeup). Under `tsx` this patch is a harmless no-op (tsx already
//     resolves those aliases itself), but it must still run before
//     anything else in the require graph reaches for them.
//  2. `dotenv/config` next — apps/server/src/database.ts and ./auth
//     read process.env at module load time (DB_PATH, AUTH_SECRET), so
//     .env must be loaded before those modules are pulled in
//     transitively via `./app`.
import './register-paths';
import 'dotenv/config';
import { createApp } from './app';
import { initializeDatabase } from './database';
import { log } from './logger';
import { registerJobHandler, startJobWorker, stopJobWorker } from './jobWorker';
import {
  CHECKIN_FOLLOWUP_JOB_TYPE,
  sendCheckinFollowup,
  type CheckinFollowupPayload,
} from './messageHandler';

const PORT = process.env.PORT || 3000;

async function startServer(): Promise<void> {
  try {
    await initializeDatabase();
    log.info('Database initialized successfully');

    // P4-A: durable job queue worker. Registration must happen before
    // startJobWorker() so the very first poll cycle already knows how to
    // handle a checkin_followup job left pending from before a restart
    // (that's the whole point of the migration off the old in-process
    // setTimeout — see CLAUDE.md's Architecture section).
    registerJobHandler(CHECKIN_FOLLOWUP_JOB_TYPE, (payload) =>
      sendCheckinFollowup(payload as unknown as CheckinFollowupPayload)
    );
    const stopWorker = startJobWorker();

    const app = createApp();
    app.listen(Number(PORT), () => {
      log.info(`Amaaii server started on port ${PORT}`);
      log.info(`WhatsApp webhook: http://localhost:${PORT}/webhook`);
      log.info(`PWA: http://localhost:${PORT}/`);
      log.info('Features Enabled', {
        features: [
          'Danger sign detection with escalation',
          'User profile management',
          'Conversation history tracking',
          'Symptom monitoring',
          'Mental health screening',
          'ANC visit tracking',
          'PWA chat interface',
          'Durable check-in follow-up queue',
        ],
      });
    });

    // Clean shutdown: stop the poller's interval before the process
    // exits. Installing a SIGTERM/SIGINT listener replaces Node's
    // default "terminate immediately" disposition for that signal, so
    // this MUST call process.exit() itself rather than merely returning
    // — otherwise a `kill <pid>` (the exact mechanism scripts/smoke's
    // cleanup traps use) would leave the process hanging forever instead
    // of exiting. Deliberately skips draining in-flight HTTP connections
    // (no server.close() wait) to keep shutdown fast and match the
    // existing "kill and move on" expectation those scripts already have.
    const shutdown = (signal: NodeJS.Signals) => {
      log.info(`Received ${signal}, shutting down`);
      stopWorker();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    log.error('Failed to start server', error);
    process.exit(1);
  }
}

startServer();
