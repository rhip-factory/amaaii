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

const PORT = process.env.PORT || 3000;

async function startServer(): Promise<void> {
  try {
    await initializeDatabase();
    log.info('Database initialized successfully');

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
        ],
      });
    });
  } catch (error) {
    log.error('Failed to start server', error);
    process.exit(1);
  }
}

startServer();
