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
import { notifyCritical } from './alerts';
import { registerJobHandler, startJobWorker, stopJobWorker } from './jobWorker';
import {
  CHECKIN_FOLLOWUP_JOB_TYPE,
  sendCheckinFollowup,
  type CheckinFollowupPayload,
} from './messageHandler';

const PORT = process.env.PORT || 3000;

// P4-B: process-level safety net, installed BEFORE any async boot work
// starts so nothing that happens during startServer() itself can slip
// past unlogged.
//
// unhandledRejection: logs and keeps running. Registering a handler
// here also changes Node's OWN default behavior for an unhandled
// rejection (current LTS default is to escalate it into an
// uncaughtException and crash) — that default is a reasonable safety
// net for code that never expected to see this, but this codebase
// already has one: the durable job queue (jobWorker.ts's runOnce())
// documents that it "never throws" and catches every failure mode
// itself, and every Express route wraps its body in try/catch, so a
// truly unhandled rejection reaching here means a code path this
// codebase's own discipline missed — worth logging loudly, not worth
// taking the whole process down over, given nothing here is holding a
// lock or mid-transaction the way a crash mid-write might justify.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', reason);
});

// uncaughtException: logs, then exits non-zero so the host's process
// supervisor restarts a clean process — standard practice for a state
// this codebase has no principled way to keep running safely from (the
// exception, by definition, escaped every try/catch this app has). The
// durable job queue (P4-A) is exactly what makes this safe to do
// unconditionally: any check-in follow-up that was pending or mid-flight
// survives in the `jobs` table and resumes on the next boot's poll
// cycle, rather than being silently lost the way the old in-process
// setTimeout would have been.
//
// KNOWN LIMITATION (documented, not fixed here — see the P4-B final
// report): notifyCritical()'s webhook POST is fire-and-forget and is
// NOT awaited before process.exit() below, so on a genuine crash the
// alert may not finish sending before the process dies. The ERROR-level
// log line (emitted synchronously, immediately before) is the reliable
// signal for this specific case — pilots relying on host log-based
// alerting (see alerts.ts's PILOTS note) are covered either way; a
// pilot relying solely on the webhook could occasionally miss a
// crash-time alert. Building a flush-before-exit guarantee for one
// low-frequency crash path was judged disproportionate for this stage.
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception — exiting so the host can restart a clean process', err);
  notifyCritical('uncaught_exception', { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

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
