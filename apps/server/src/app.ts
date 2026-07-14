// P1-E: Express app factory — ported 1:1 from server.js (final step of
// the TS migration; see CLAUDE.md). All routes/middleware from the
// original server.js are wired here; apps/server/src/index.ts owns only
// env loading, DB init, and app.listen(). Exported as a factory
// (createApp) rather than a singleton app instance so tests can spin up
// independent instances (supertest-style) without sharing state.

import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import bodyParser from 'body-parser';
import { handleIncomingMessage, processMessage } from './messageHandler';
import {
  getUser,
  updateUser,
  getTodaysJournal,
  getTodaysJournals,
  getJournalHistory,
  getConversationHistory,
  getMedicalHistory,
  saveMedicalHistory,
  getOtp,
  createOrReplaceOtp,
  recordOtpAttempt,
  deleteOtp,
} from './database';
import { getRecentTrend } from './trend';
import * as llmExtract from './llmExtract';
import { log } from './logger';
import twilioSignature from './middleware/twilioSignature';
import * as auth from './auth';
import { generateOtpCode, hashOtpCode, hashesMatch } from './otp';
import { PUBLIC_DIR } from './paths';
import { sendWhatsAppMessage } from '@amaaii/adapters';
import {
  checkOtpRateLimit,
  pruneSentTimestamps,
  formatRateLimitMessage,
  isOtpExpired,
  formatWrongCodeMessage,
  OTP_MAX_ATTEMPTS,
  OTP_EXPIRY_MS,
} from '@amaaii/core';
import type { JournalRow } from '@amaaii/core';
import userManager, { type UserWithFlag } from './userManager';

// The original JS attached `req.userPhone` ad hoc inside requireAuth();
// this augmentation gives that the same (optional — set by middleware,
// not guaranteed by the type system any more than the original JS
// guaranteed it at runtime) shape under strict mode. `declare global` +
// the `Express.Request` namespace is the idiomatic augmentation target
// for @types/express (rather than naming the `express-serve-static-core`
// package directly, which classic Node module resolution can't locate
// as an augmentation target from this file).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userPhone?: string;
    }
  }
}

const PROFILE_FIELDS = ['name', 'age', 'pregnancy_week', 'location', 'language'] as const;

function trimesterFromWeek(w?: number | null): string | null {
  if (!w) return null;
  if (w < 13) return 'first trimester';
  if (w < 27) return 'second trimester';
  return 'third trimester';
}

function weekDescription(week?: number | null): string | null {
  if (!week) return null;
  // Light week-by-week copy. Phase 2 plugs in WHO content.
  const descriptions: (string | null)[] = [
    null,
    'Conception window — your body is just starting the journey.',
    "It's very early — most of the changes are happening at a cellular level.",
    'Your baby is the size of a poppy seed. Big changes are starting.',
    'About the size of a sesame seed — the neural tube is forming.',
    'Size of an apple seed; the heart is beginning to beat.',
    'Size of a sweet pea; tiny limb buds are forming.',
    'Size of a blueberry; little arms and legs are taking shape.',
    'Size of a kidney bean; rapid neural growth this week.',
    'About the size of a grape; baby is now officially a fetus.',
    'About the size of a strawberry; reflexes are beginning.',
    'Size of a lime; fingernails are forming.',
    "Size of a passion fruit; movements you can't yet feel.",
    'Welcome to the second trimester — energy often returns this week.',
    'Size of a lemon; baby can squint and frown.',
    'Size of an orange; tiny bones are hardening.',
    'Size of an avocado; you might start feeling fluttering.',
    'Size of a turnip; baby is making facial expressions.',
    'Size of a bell pepper; vernix is forming on the skin.',
    'Size of a sweet potato; baby can hear sounds outside.',
    'Halfway there — size of a banana, and movements get stronger.',
    'Size of a carrot; eyebrows and lashes are growing in.',
    'Size of a spaghetti squash; baby is gaining weight steadily.',
    'Size of a small papaya; the inner ear is fully developed.',
    'Size of a corn cob; baby responds to your voice now.',
    'Size of a head of cauliflower; lungs are practising breathing.',
    'Size of a lettuce; eyes are opening for the first time.',
    'Welcome to the third trimester — baby is the size of an eggplant.',
    'Size of a butternut squash; brain growth accelerates.',
    'Size of a cabbage; baby is settling into a sleep schedule.',
    'Size of a coconut; you may notice Braxton-Hicks contractions.',
    'Size of a pineapple; baby is curling up for less room.',
    'Baby is roughly 4 pounds and adding fat each day.',
    'Lungs are nearly mature; baby will likely turn head-down soon.',
    'Size of a honeydew melon; fingernails reach the fingertips.',
    'Size of a romaine lettuce; baby is full term in two weeks.',
    'Considered "early term" — baby continues to gain weight.',
    'Full term ahead — keep your hospital bag ready.',
    'Full term — baby could arrive any day now.',
    'Due any day. Watch for labor signs.',
    'Past due — your provider may discuss next steps.',
  ];
  return descriptions[week] || `Week ${week} — keep listening to your body and resting when you can.`;
}

function tipFor(
  user: Pick<UserWithFlag, 'pregnancy_week'> | null,
  todayJournal: JournalRow | null
): { headline: string; body: string } {
  if (!user || !user.pregnancy_week) {
    return { headline: 'Add your pregnancy week', body: 'Once I know how far along you are, the tips and reminders here become much more useful.' };
  }
  if (todayJournal) {
    return { headline: 'Nice work checking in', body: "You've already journaled today. A short walk and a glass of water are two of the best things you can do this week." };
  }
  return { headline: 'Hydration first', body: 'Aim for 8 glasses of water today. Pair it with the daily journal — it takes about two minutes.' };
}

function formatJournalRow(j: JournalRow): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (j.emotional_state != null) {
    const e = j.emotional_state;
    const emoji = e >= 7 ? '😊' : e >= 5 ? '😐' : '😔';
    rows.push({ label: 'Mood', value: `${e}/10 ${emoji}` });
  }
  if (j.physical_symptoms && j.physical_symptoms !== 'none') {
    let s: string = j.physical_symptoms;
    if (typeof s === 'string' && s.trim().startsWith('[')) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) s = arr.map((x) => String(x).replace(/_/g, ' ')).join(', ');
      } catch (_) { /* leave s as-is */ }
    }
    rows.push({ label: 'Symptoms', value: s });
  }
  if (j.sleep_hours != null || j.sleep_quality != null) {
    const parts: string[] = [];
    if (j.sleep_quality != null) parts.push(`${j.sleep_quality}/10`);
    if (j.sleep_hours != null) parts.push(`${j.sleep_hours}h`);
    rows.push({ label: 'Sleep', value: parts.join(' · ') });
  }
  if (j.water_intake != null) rows.push({ label: 'Water', value: `${j.water_intake} glasses` });
  if (j.appetite) rows.push({ label: 'Appetite', value: j.appetite });
  if (j.red_flags_detected) rows.push({ label: '⚠️ Flagged', value: j.red_flags_detected });
  if (j.completed_at && j.started_at) {
    const dur = Math.max(1, Math.round((new Date(j.completed_at).getTime() - new Date(j.started_at).getTime()) / 1000));
    rows.push({ label: 'Duration', value: dur < 60 ? `${dur}s` : `${Math.round(dur / 60)} min` });
  }
  return rows;
}

function formatTime(iso?: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (_) { return ''; }
}

export function createApp(): Express {
  const app = express();

  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());

  // Twilio WhatsApp webhook
  app.post('/webhook', twilioSignature, async (req: Request, res: Response) => {
    try {
      const { From, Body, ProfileName } = req.body;
      log.info('Received message', { From, ProfileName, Body });
      await handleIncomingMessage(From, Body, ProfileName);
      res.status(200).send('Message received');
    } catch (error) {
      log.error('Error processing message', error);
      res.status(500).send('Error processing message');
    }
  });

  app.get('/webhook', (req: Request, res: Response) => {
    res.send('WhatsApp Bot Webhook is running!');
  });

  // --- Auth -----------------------------------------------------------------
  // Phase A demo auth: phone-only sign-in, no OTP. Real verification lands
  // in Phase 3. The token is HMAC-signed so the client can't forge a phone.
  app.post('/auth/login', (req: Request, res: Response) => {
    const { phone } = req.body || {};
    const normalized = auth.normalizePhone(phone);
    if (!normalized) {
      res.status(400).json({ error: 'invalid_phone', message: 'Please enter a valid phone number.' });
      return;
    }
    const token = auth.issueToken(normalized);
    log.info('PWA login', { phone: normalized });
    res.json({ token, user: { phone: normalized } });
  });

  // --- OTP auth (P2-B) --------------------------------------------------------
  // Real sign-in flow: request a 6-digit code, then verify it for a bearer
  // token in the same shape POST /auth/login returns. POST /auth/login above
  // stays wired for back-compat (existing tests + a phone-only fallback).
  //
  // Delivery: if Twilio creds + a WhatsApp sender number are configured, the
  // code is sent as a WhatsApp message. Otherwise this is DEV MODE — the code
  // is logged (through the redacting logger; the phone is masked
  // automatically by its phone-pattern regex, the code itself is short-lived
  // enough to log in the clear) and returned inline as `devCode` so the whole
  // flow is testable/usable without Twilio, but only when NODE_ENV isn't
  // 'production'.
  app.post('/auth/otp/request', async (req: Request, res: Response) => {
    try {
      const { phone } = req.body || {};
      const normalized = auth.normalizePhone(phone);
      if (!normalized) {
        res.status(400).json({ error: 'invalid_phone', message: 'Please enter a valid phone number.' });
        return;
      }

      const now = new Date();
      const existing = await getOtp(normalized);
      const priorSends = existing?.sentTimestamps ?? [];
      const rateCheck = checkOtpRateLimit(priorSends, now);
      if (rateCheck.limited) {
        res.status(429).json({
          error: 'rate_limited',
          message: formatRateLimitMessage(rateCheck.retryAfterMs),
          retryAfterSeconds: Math.ceil(rateCheck.retryAfterMs / 1000),
        });
        return;
      }

      const code = generateOtpCode();
      const twilioConfigured = !!(
        process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_WHATSAPP_NUMBER
      );

      let devCode: string | undefined;
      if (twilioConfigured) {
        try {
          await sendWhatsAppMessage(
            normalized,
            `Your Amaaii sign-in code is ${code}. It expires in 10 minutes.`
          );
        } catch (err) {
          log.error('Failed to send OTP via WhatsApp', err, { phone: normalized });
          res.status(502).json({
            error: 'delivery_failed',
            message: 'Could not send the code. Please try again in a moment.',
          });
          return;
        }
      } else {
        log.info('OTP dev-mode code generated (no Twilio creds configured)', {
          phone: normalized,
          code,
        });
        if (process.env.NODE_ENV !== 'production') {
          devCode = code;
        }
      }

      // Only persist (and count against the rate limit) once delivery
      // actually happened — a failed Twilio send above returns before this,
      // so it doesn't burn a rate-limit slot or invalidate a still-good code.
      const sentTimestamps = [...pruneSentTimestamps(priorSends, now), now.toISOString()];
      await createOrReplaceOtp(
        normalized,
        hashOtpCode(normalized, code),
        new Date(now.getTime() + OTP_EXPIRY_MS).toISOString(),
        sentTimestamps
      );

      res.json({ sent: true, ...(devCode ? { devCode } : {}) });
    } catch (err) {
      log.error('POST /auth/otp/request failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.post('/auth/otp/verify', async (req: Request, res: Response) => {
    try {
      const { phone, code } = req.body || {};
      const normalized = auth.normalizePhone(phone);
      if (!normalized) {
        res.status(400).json({ error: 'invalid_phone', message: 'Please enter a valid phone number.' });
        return;
      }
      if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
        res.status(400).json({ error: 'invalid_code', message: 'Enter the 6-digit code.' });
        return;
      }
      const trimmedCode = code.trim();

      const record = await getOtp(normalized);
      if (!record) {
        res.status(400).json({
          error: 'no_code',
          message: 'No active code for this number — request a new one.',
        });
        return;
      }

      const now = new Date();
      if (isOtpExpired(record.expiresAt, now)) {
        await deleteOtp(normalized);
        res.status(410).json({ error: 'expired', message: 'Code expired — send a new one.' });
        return;
      }

      if (record.attempts >= OTP_MAX_ATTEMPTS) {
        await deleteOtp(normalized);
        res.status(429).json({
          error: 'too_many_attempts',
          message: 'Too many incorrect tries — send a new code.',
        });
        return;
      }

      const candidateHash = hashOtpCode(normalized, trimmedCode);
      if (!hashesMatch(candidateHash, record.codeHash)) {
        const attempts = await recordOtpAttempt(normalized);
        const remaining = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
        if (remaining === 0) {
          await deleteOtp(normalized);
          res.status(429).json({
            error: 'too_many_attempts',
            message: 'Too many incorrect tries — send a new code.',
          });
          return;
        }
        res.status(401).json({
          error: 'wrong_code',
          message: formatWrongCodeMessage(remaining),
          attemptsRemaining: remaining,
        });
        return;
      }

      await deleteOtp(normalized);
      // Same fix as GET/PUT /me below: ensure the user row exists so a
      // phone that has only ever signed in via OTP (never messaged
      // WhatsApp) isn't a ghost until its first /chat turn.
      await userManager.getOrCreateUser(normalized);
      const token = auth.issueToken(normalized);
      log.info('PWA OTP login', { phone: normalized });
      res.json({ token, user: { phone: normalized } });
    } catch (err) {
      log.error('POST /auth/otp/verify failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // Bearer-token middleware. Attaches req.userPhone if a valid token is
  // present; rejects with 401 otherwise.
  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.get('authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      res.status(401).json({ error: 'missing_token' });
      return;
    }
    const payload = auth.verifyToken(m[1]);
    if (!payload || !payload.sub) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    req.userPhone = payload.sub;
    next();
  }

  // PWA chat endpoint — same brain as the WhatsApp webhook. The user phone
  // comes from the auth token; users keyed by `whatsapp:+E.164` so a phone
  // that has messaged the WhatsApp sandbox sees its conversation history
  // after logging in to the PWA.
  app.post('/chat', requireAuth, async (req: Request, res: Response) => {
    try {
      const { message } = req.body || {};
      if (typeof message !== 'string' || message.trim().length === 0) {
        res.status(400).json({ error: 'message is required' });
        return;
      }
      log.info('PWA message received', { phone: req.userPhone, message });
      const result = await processMessage(req.userPhone as string, message, null);
      res.json({
        response: result.response,
        urgencyLevel: result.urgencyLevel,
        context: result.context,
      });
    } catch (error) {
      log.error('Error in /chat', error);
      res.status(500).json({
        error: 'internal_error',
        response: "I apologize, I'm having trouble processing that. Please try again.",
      });
    }
  });

  app.get('/me', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      // P2-B fix: getOrCreate (not getUser) — a phone that only ever
      // signed in via OTP/demo login (never sent a WhatsApp/chat message,
      // which used to be the only path that created the row via
      // processMessage) previously hit the `!user` placeholder branch
      // forever. See the PUT /me fix below for the write-side half of the
      // same bug.
      const user = await userManager.getOrCreateUser(userPhone);
      const todaysJournals = await getTodaysJournals(userPhone);
      const completedToday = todaysJournals.filter((j) => j.completed);
      const lastJournal = todaysJournals[todaysJournals.length - 1] || null;
      res.json({
        user: {
          phone: user.phone_number,
          name: user.name,
          age: user.age,
          pregnancy_week: user.pregnancy_week,
          edd: user.edd,
          location: user.location,
          language: user.language || 'en',
          trimester: trimesterFromWeek(user.pregnancy_week),
        },
        todayJournal: lastJournal
          ? {
              completed: !!lastJournal.completed,
              emotional_state: lastJournal.emotional_state,
              sleep_hours: lastJournal.sleep_hours,
              water_intake: lastJournal.water_intake,
              appetite: lastJournal.appetite,
              started_at: lastJournal.started_at,
              completed_at: lastJournal.completed_at,
            }
          : null,
        todayCheckinCount: completedToday.length,
        weekDescription: weekDescription(user.pregnancy_week),
        tip: tipFor(user, lastJournal),
        trend: await getRecentTrend(userPhone, 7),
      });
    } catch (err) {
      log.error('GET /me failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.put('/me', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      // P2-B fix (flagged in P2-A): the user row used to be created only
      // inside processMessage (the WhatsApp/chat path), so a PUT /me
      // before any chat turn ran an UPDATE against zero rows and
      // silently no-op'd. getOrCreate first so the row always exists.
      await userManager.getOrCreateUser(userPhone);
      const updates: Record<string, unknown> = {};
      for (const key of PROFILE_FIELDS) {
        const v = (req.body || {})[key];
        if (v === undefined) continue;
        if (v === null || v === '') {
          // Skip clearing fields for the demo (avoids DB layer rejecting null)
          continue;
        }
        updates[key] = v;
      }
      if (Object.keys(updates).length === 0) {
        const user = await getUser(userPhone);
        res.json({ user });
        return;
      }
      // Keys are drawn only from PROFILE_FIELDS above, a subset of
      // updateUser's whitelist — this cast documents that runtime
      // filtering rather than re-deriving it in the type system.
      await updateUser(userPhone, updates as Parameters<typeof updateUser>[1]);
      const user = await getUser(userPhone);
      res.json({ user });
    } catch (err) {
      log.error('PUT /me failed', err);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Medical history (Phase D) ---------------------------------------------
  app.get('/me/medical-history', requireAuth, async (req: Request, res: Response) => {
    try {
      const mh = await getMedicalHistory(req.userPhone as string);
      res.json({ medicalHistory: mh });
    } catch (err) {
      log.error('GET /me/medical-history failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.post('/me/medical-history', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      const { rawText, overwrite } = req.body || {};
      if (typeof rawText !== 'string') {
        res.status(400).json({ error: 'rawText is required.' });
        return;
      }
      const trimmed = rawText.trim();
      // Min length (20 chars) and word count (≥4) blocks gibberish like "12345"
      // from silently wiping a real record.
      const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
      if (trimmed.length < 20 || wordCount < 4) {
        res.status(400).json({
          error: 'rawText too short — please add a few more details.',
        });
        return;
      }
      const extracted = await llmExtract.extractMedicalHistory(trimmed);
      const isUseful = !!extracted && Object.keys(extracted).filter((k) => {
        const v = extracted[k];
        if (Array.isArray(v)) return v.length > 0;
        if (v && typeof v === 'object') return Object.values(v).some((x) => x != null);
        return v != null;
      }).length > 0;
      // If the LLM extracted nothing AND a richer record already exists,
      // refuse the overwrite unless the caller explicitly opts in.
      const existing = await getMedicalHistory(userPhone);
      if (!isUseful && existing && existing.rawText && !overwrite) {
        res.status(409).json({
          error: 'no_extractable_data',
          message: "I couldn't extract any structured info from that. Pass overwrite=true to replace your saved history anyway.",
          currentRecord: existing,
        });
        return;
      }
      await saveMedicalHistory(userPhone, { rawText: trimmed, extracted: extracted || {} });
      const mh = await getMedicalHistory(userPhone);
      res.json({ medicalHistory: mh, extracted: extracted || null });
    } catch (err) {
      log.error('POST /me/medical-history failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.get('/history', requireAuth, async (req: Request, res: Response) => {
    try {
      const journals = await getJournalHistory(req.userPhone as string, 30);
      const days = (journals || []).map((j) => {
        const startTime = formatTime(j.started_at);
        const status = j.completed
          ? (j.completed_at ? `completed at ${formatTime(j.completed_at)}` : 'completed')
          : 'in progress';
        const label = startTime ? `${j.date} · started ${startTime} · ${status}` : `${j.date} · ${status}`;
        return { label, rows: formatJournalRow(j) };
      }).filter((d) => d.rows.length > 0);
      res.json({ days });
    } catch (err) {
      log.error('GET /history failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // Static PWA assets (index.html, manifest, sw.js, img/, etc.)
  app.use(express.static(PUBLIC_DIR));

  // Friendly root: serve the PWA when public/index.html exists, otherwise
  // fall back to the legacy WhatsApp-only health string.
  app.get('/', (req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
      if (err) res.send('WhatsApp Pregnancy Bot Server is running!');
    });
  });

  return app;
}
