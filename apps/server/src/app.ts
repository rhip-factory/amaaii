// P1-E: Express app factory — ported 1:1 from server.js (final step of
// the TS migration; see CLAUDE.md). All routes/middleware from the
// original server.js are wired here; apps/server/src/index.ts owns only
// env loading, DB init, and app.listen(). Exported as a factory
// (createApp) rather than a singleton app instance so tests can spin up
// independent instances (supertest-style) without sharing state.

import fs from 'node:fs';
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
  createOrUpdateJournal,
  findJournalByClientEntryId,
  getConversationHistory,
  getMedicalHistory,
  saveMedicalHistory,
  getOtp,
  createOrReplaceOtp,
  recordOtpAttempt,
  deleteOtp,
  getConsents,
  recordConsent,
  revokeConsent,
  getAllConversationsForUser,
  getAllJournalsForUser,
  getAllSymptomsForUser,
  getAllAncVisitsForUser,
  listAuditForUser,
  eraseUser,
  countJobsByStatus,
  pingDatabase,
  getFacility,
  getProviderByEmail,
  getEnrollmentsByFacility,
  getEnrollment,
  enrollPatient,
  getEscalationAcksByFacility,
  ackEscalation,
} from './database';
import { getRecentTrend } from './trend';
import * as llmExtract from './llmExtract';
import { log } from './logger';
import twilioSignature from './middleware/twilioSignature';
import { requestObservability } from './middleware/requestObservability';
import * as auth from './auth';
import * as providerAuth from './providerAuth';
import { generateOtpCode, hashOtpCode, hashesMatch } from './otp';
import { WEB_OUT_DIR, REPO_ROOT } from './paths';
import { sendWhatsAppMessage } from '@amaaii/adapters';
import {
  renderMetrics,
  incrementOtpRequest,
  incrementOtpVerification,
} from './metrics';
import { globalErrorHandler } from './errorHandler';
import {
  checkOtpRateLimit,
  pruneSentTimestamps,
  formatRateLimitMessage,
  isOtpExpired,
  formatWrongCodeMessage,
  OTP_MAX_ATTEMPTS,
  OTP_EXPIRY_MS,
  detectDangerSigns,
  dangerCopy,
  pickLang,
  extractSymptoms,
  SYMPTOM_VALUES,
  computeTrend,
  computeDailySeries,
  computeSymptomCounts,
  computeRedFlagDates,
  CONSENT_VERSION,
  REQUIRED_PURPOSES,
  OPTIONAL_PURPOSES,
  deriveConsentState,
  hasActiveConsent,
  needsConsent,
  isStale,
  canUseAi,
  assessTriage,
  computeCohortAggregate,
} from '@amaaii/core';
import type {
  JournalPatch,
  JournalRow,
  Symptom,
  ConsentPurpose,
  ConsentState,
  CohortMotherInput,
} from '@amaaii/core';
import { recordAuditSafe, auditDangerEscalation, wasAccountDeleted } from './audit';
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
      // P5-A: set by requireProviderAuth (never by requireAuth — see
      // providerAuth.ts's header for why the two token types can never
      // populate each other's fields).
      providerId?: number;
      facilityId?: number;
      providerRole?: string;
    }
  }
}

const PROFILE_FIELDS = ['name', 'age', 'pregnancy_week', 'location', 'language'] as const;

// P4-B: read once at module load (not per-request — GET /health must
// return fast) from the repo's own package.json via paths.ts's REPO_ROOT,
// the same "walk up to find package.json, works under tsx AND a
// compiled dist/ boot" resolution WEB_OUT_DIR already relies on. Falls
// back to 'unknown' rather than throwing if the read ever fails — a
// liveness probe must never itself be a reason the process looks down.
const APP_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

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
  if (!user || user.pregnancy_week == null) {
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

// --- POST /journal/entries (P2-C) --------------------------------------------
// Structured check-in form for the PWA. Writes the SAME journal_data shape
// (journals table columns) the WhatsApp state machine produces — see
// apps/server/src/journalManager.ts's 'symptoms'/'sleep'/'appetite'/
// 'baby_movement'/'notes' stages, which this mirrors field-for-field so
// weekly summaries, doctor reports, and trend computation keep working
// across both entry points.

const APPETITE_LEVELS = new Set(['good', 'moderate', 'poor']);

interface JournalEntryInput {
  clientEntryId: string;
  mood: number;
  symptoms: string[];
  symptomsText: string;
  sleepHours: number;
  appetite: string;
  babyMovement?: number;
  note: string;
}

type ValidationResult =
  | { ok: true; value: JournalEntryInput }
  | { ok: false; error: string; message: string };

// Honest, field-named 400s — every failure names exactly which field was
// wrong so the form can point the user at it directly.
function validateJournalEntryInput(body: unknown): ValidationResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  if (typeof b.clientEntryId !== 'string' || b.clientEntryId.trim().length === 0) {
    return { ok: false, error: 'invalid_clientEntryId', message: 'clientEntryId is required.' };
  }
  const clientEntryId = b.clientEntryId.trim();

  const mood = b.mood;
  if (typeof mood !== 'number' || !Number.isInteger(mood) || mood < 1 || mood > 10) {
    return { ok: false, error: 'invalid_mood', message: 'mood must be a whole number from 1 to 10.' };
  }

  let symptoms: string[] = [];
  if (b.symptoms !== undefined) {
    if (!Array.isArray(b.symptoms) || b.symptoms.some((s) => typeof s !== 'string')) {
      return { ok: false, error: 'invalid_symptoms', message: 'symptoms must be an array of strings.' };
    }
    const unknown = (b.symptoms as string[]).filter((s) => !SYMPTOM_VALUES.includes(s as Symptom));
    if (unknown.length > 0) {
      return { ok: false, error: 'invalid_symptoms', message: `Unknown symptom(s): ${unknown.join(', ')}` };
    }
    symptoms = b.symptoms as string[];
  }

  const symptomsText = typeof b.symptomsText === 'string' ? b.symptomsText.trim() : '';

  const sleepHours = b.sleepHours;
  if (typeof sleepHours !== 'number' || Number.isNaN(sleepHours) || sleepHours < 0 || sleepHours > 24) {
    return { ok: false, error: 'invalid_sleepHours', message: 'sleepHours must be a number between 0 and 24.' };
  }

  const appetite = b.appetite;
  if (typeof appetite !== 'string' || !APPETITE_LEVELS.has(appetite)) {
    return { ok: false, error: 'invalid_appetite', message: "appetite must be one of 'good', 'moderate', 'poor'." };
  }

  let babyMovement: number | undefined;
  if (b.babyMovement !== undefined && b.babyMovement !== null) {
    if (typeof b.babyMovement !== 'number' || !Number.isInteger(b.babyMovement) || b.babyMovement < 0) {
      return { ok: false, error: 'invalid_babyMovement', message: 'babyMovement must be a non-negative whole number.' };
    }
    babyMovement = b.babyMovement;
  }

  const note = typeof b.note === 'string' ? b.note.trim() : '';

  return {
    ok: true,
    value: { clientEntryId, mood, symptoms, symptomsText, sleepHours, appetite, babyMovement, note },
  };
}

// Mirrors core's parseSymptomsAnswer() value shape exactly (JSON array
// string | 'none' | raw text) so formatSymptoms()/extractWeeklySymptoms()/
// computeTrend() in packages/core treat form-written rows identically to
// WhatsApp-written ones. `symptoms` is the curated chip selection;
// `symptomsText` is optional freeform text re-scanned for any additional
// recognised symptoms (mirrors scanFreeText's merge behavior).
function buildPhysicalSymptoms(symptoms: string[], symptomsText: string): string {
  const fromText = symptomsText ? extractSymptoms(symptomsText) : [];
  const merged = Array.from(new Set<string>([...symptoms, ...fromText]));
  if (merged.length > 0) return JSON.stringify(merged);
  if (symptomsText) return symptomsText;
  return 'none';
}

function toJournalEntryView(row: JournalRow) {
  const raw = row.physical_symptoms;
  let symptoms: string[] = [];
  let symptomsText: string | null = null;
  if (raw && raw !== 'none') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) symptoms = arr.map(String);
      } catch (_) { symptomsText = trimmed; }
    } else {
      symptomsText = trimmed;
    }
  }
  return {
    id: row.id,
    date: row.date,
    clientEntryId: row.client_entry_id ?? null,
    mood: row.emotional_state ?? null,
    symptoms,
    symptomsText,
    sleepHours: row.sleep_hours ?? null,
    appetite: row.appetite ?? null,
    babyMovement: row.baby_movement_count ?? null,
    note: row.special_notes ?? null,
    hasRedFlags: !!row.red_flags_detected,
    completed: !!row.completed,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export interface CreateAppOptions {
  // Test seam only (mirrors @amaaii/adapters' twilio.ts __setSendImpl
  // pattern): lets tests point the static-export serving at a small
  // fixture directory, or at a path that deliberately doesn't exist,
  // without depending on whether the real apps/web/out happens to be
  // built on whatever machine the suite runs on. Production callers
  // (apps/server/src/index.ts) never pass this — they get the real
  // WEB_OUT_DIR from paths.ts.
  webOutDirOverride?: string;
  // P4-B test seam ONLY: mounts a route that unconditionally throws, so
  // tests/observability.test.ts can drive the global error handler
  // (errorHandler.ts) deterministically without depending on a
  // coincidental existing failure path. Never set by production callers
  // (apps/server/src/index.ts never passes it) — the route does not
  // exist unless a test explicitly opts in.
  enableTestErrorRoute?: boolean;
}

export function createApp(opts: CreateAppOptions = {}): Express {
  const app = express();

  // P4-B: mounted FIRST — before body-parsing, before every route — so
  // the correlation id / timing / completion log wraps the ENTIRE
  // request lifecycle, including a body-parser JSON error and whatever
  // the global error handler (registered LAST, below) ends up doing.
  // See middleware/requestObservability.ts's header for the full design.
  app.use(requestObservability);

  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());

  // --- Ops endpoints (P4-B) ---------------------------------------------
  // Unauthenticated by design (a load balancer / host / scraper calls
  // these, not a logged-in user) and mounted ahead of every other route
  // so they can never be shadowed by the PWA static-export catch-all
  // further down. Neither collides with a PWA page route — apps/web's
  // page set (see apps/web/src/app/*/page.tsx) has no '/health' or
  // '/metrics' page, unlike '/insights' and '/chat', which is why
  // neither needs that pair's X-Amaaii-Api-header discrimination.

  // GET /health — liveness: the process is up and can respond. Must
  // return FAST and never touch a request's user data or the DB — if
  // this handler ever blocks, a host's liveness probe would start
  // killing/restarting an otherwise-healthy process.
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime(), version: APP_VERSION });
  });

  // GET /health/ready — readiness: the process is up AND its
  // dependencies are reachable. Today that's just SQLite — a trivial
  // `SELECT 1` proves the connection/file is actually usable, not just
  // that the module loaded. 503 (not 200-with-a-flag) on failure so a
  // host's readiness check can act on the HTTP status directly without
  // parsing the body.
  app.get('/health/ready', async (_req: Request, res: Response) => {
    try {
      await pingDatabase();
      res.status(200).json({ status: 'ok' });
    } catch (err) {
      log.error('GET /health/ready: DB check failed', err);
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // GET /metrics — Prometheus text exposition (see metrics.ts's header
  // for the format/dependency-free rationale). Gated behind
  // METRICS_TOKEN when set (any environment); when unset, served openly
  // in non-production (dev/CI/smoke convenience) but 404'd in production
  // — an unauthenticated pilot deploy should never expose request
  // volumes/route shapes/job counts to the open internet by accident.
  // PII: every label here is a closed vocabulary (route templates,
  // status classes, urgency levels, job statuses) — see metrics.ts's
  // header; this handler adds no new label surface of its own.
  app.get('/metrics', async (req: Request, res: Response) => {
    const token = process.env.METRICS_TOKEN;
    if (token) {
      const header = req.get('authorization') || '';
      const match = header.match(/^Bearer\s+(.+)$/i);
      if (!match || match[1] !== token) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
    } else if (process.env.NODE_ENV === 'production') {
      res.status(404).end();
      return;
    }
    const jobs = await countJobsByStatus().catch((err) => {
      log.error('GET /metrics: countJobsByStatus failed (jobs_total omitted)', err);
      return null;
    });
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(renderMetrics({ jobs }));
  });

  // P4-B test seam — see CreateAppOptions.enableTestErrorRoute above.
  if (opts.enableTestErrorRoute) {
    app.get('/__test/throw', () => {
      throw new Error('boom (test-only route, apps/server/src/app.ts#enableTestErrorRoute)');
    });
  }

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
  // Phase A demo auth: phone-only sign-in, no OTP. Superseded by the OTP flow
  // below. The token is HMAC-signed so the client can't forge a phone.
  //
  // SECURITY — DISABLED IN PRODUCTION. This endpoint mints a full 30-day
  // bearer token from a phone number ALONE: no code, no secret, nothing the
  // caller has to prove. A phone number is public information, so on a
  // publicly-reachable deployment this is a complete authentication bypass —
  // anyone could take a token for any mother's number and then read, export,
  // or erase her health data through /me, /history, /insights, /me/export and
  // DELETE /me/account, walking straight past both the OTP challenge and
  // every Phase 3 data-rights protection.
  //
  // It stays available OUTSIDE production because ~12 test files and the
  // local dev flow use it as a convenient token factory (see
  // tests/postDeleteReadHardening.test.ts, which specifically pins that this
  // path does NOT create a users row). Gating on NODE_ENV keeps all of that
  // working while closing the hole on any real deployment.
  //
  // Responds 404 rather than 403 so a production deployment doesn't advertise
  // that the endpoint exists at all. Pinned by tests/legacyLoginGate.test.ts.
  app.post('/auth/login', (req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
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
        incrementOtpRequest('invalid_phone');
        res.status(400).json({ error: 'invalid_phone', message: 'Please enter a valid phone number.' });
        return;
      }

      const now = new Date();
      const existing = await getOtp(normalized);
      const priorSends = existing?.sentTimestamps ?? [];
      const rateCheck = checkOtpRateLimit(priorSends, now);
      if (rateCheck.limited) {
        incrementOtpRequest('rate_limited');
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
          incrementOtpRequest('delivery_failed');
          log.error('Failed to send OTP via WhatsApp', err, { phone: normalized });
          res.status(502).json({
            error: 'delivery_failed',
            message: 'Could not send the code. Please try again in a moment.',
          });
          return;
        }
        incrementOtpRequest('sent');
      } else {
        log.info('OTP dev-mode code generated (no Twilio creds configured)', {
          phone: normalized,
          code,
        });
        if (process.env.NODE_ENV !== 'production') {
          devCode = code;
        }
        incrementOtpRequest('dev_mode');
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
        incrementOtpVerification('invalid_phone');
        res.status(400).json({ error: 'invalid_phone', message: 'Please enter a valid phone number.' });
        return;
      }
      if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
        incrementOtpVerification('invalid_code');
        res.status(400).json({ error: 'invalid_code', message: 'Enter the 6-digit code.' });
        return;
      }
      const trimmedCode = code.trim();

      const record = await getOtp(normalized);
      if (!record) {
        incrementOtpVerification('no_code');
        res.status(400).json({
          error: 'no_code',
          message: 'No active code for this number — request a new one.',
        });
        return;
      }

      const now = new Date();
      if (isOtpExpired(record.expiresAt, now)) {
        await deleteOtp(normalized);
        incrementOtpVerification('expired');
        res.status(410).json({ error: 'expired', message: 'Code expired — send a new one.' });
        return;
      }

      if (record.attempts >= OTP_MAX_ATTEMPTS) {
        await deleteOtp(normalized);
        incrementOtpVerification('too_many_attempts');
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
          incrementOtpVerification('too_many_attempts');
          res.status(429).json({
            error: 'too_many_attempts',
            message: 'Too many incorrect tries — send a new code.',
          });
          return;
        }
        incrementOtpVerification('wrong_code');
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
      await recordAuditSafe({ actor: normalized, action: 'login', resource: 'account', resourceOwner: normalized, metadata: { method: 'otp' } });
      incrementOtpVerification('success');
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
    // P5-A: a provider token (providerAuth.ts#issueProviderToken) is
    // signed with the SAME AUTH_SECRET, so it verifies fine on the HMAC
    // check above alone — its namespaced `provider:<id>` sub is the only
    // thing distinguishing it from a mother token. Reject explicitly
    // rather than trusting that downstream code never matches a
    // `provider:...` string against a users row by coincidence. See
    // providerAuth.ts's header for the full cross-token boundary and
    // tests/providerPortal.test.ts for both-directions coverage.
    if (payload.sub.startsWith('provider:')) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    req.userPhone = payload.sub;
    next();
  }

  // P5-A: provider-portal counterpart to requireAuth above. See
  // providerAuth.ts's header for the namespacing that keeps this from
  // ever accepting a mother token — verifyProviderToken() rejects any
  // sub that doesn't carry the `provider:` prefix, which covers every
  // mother token (auth.ts#normalizePhone always produces
  // `whatsapp:+...`).
  function requireProviderAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.get('authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      res.status(401).json({ error: 'missing_token' });
      return;
    }
    const payload = providerAuth.verifyProviderToken(m[1]);
    if (!payload) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    req.providerId = payload.providerId;
    req.facilityId = payload.facilityId;
    req.providerRole = payload.role;
    next();
  }

  // --- Consent (P3-B) ---------------------------------------------------------
  // Two-tier model (packages/core/src/consent.ts): data_processing is
  // REQUIRED (the app has no lawful basis to keep operating for a user
  // without it, modulo the vital-interests danger-escalation carve-out
  // enforced independently in messageHandler.ts); ai_responses is
  // OPTIONAL and only ever turns the LLM chokepoint on/off.
  const ALL_PURPOSES: ConsentPurpose[] = [...REQUIRED_PURPOSES, ...OPTIONAL_PURPOSES];

  function buildConsentView(state: ConsentState) {
    const purposes = ALL_PURPOSES.map((purpose) => {
      const entry = state.find((e) => e.purpose === purpose);
      return {
        purpose,
        granted: entry ? entry.granted : false,
        active: hasActiveConsent(state, purpose),
        version: entry ? entry.version : null,
      };
    });
    return {
      version: CONSENT_VERSION,
      needsConsent: needsConsent(state),
      isStale: isStale(state),
      purposes,
      canUseAi: canUseAi(state),
    };
  }

  app.get('/me/consent', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      // P3-E: this route never creates a `users` row (consent lives in
      // its own table, keyed by phone), so it never literally
      // "resurrects" anything — but a deleted account's still-valid
      // bearer token would otherwise get a plausible-looking
      // "needsConsent: true" response forever, as if nothing happened.
      // Gate ONLY on "no current row AND was deleted before" (not
      // wasAccountDeleted alone) — a phone that deletes and later signs
      // up again for real (fresh OTP verify, which recreates the row)
      // must not stay locked out just because its audit log still
      // remembers an old delete event. See userManager.ts#getUserForRead
      // for the same current-row-first pattern.
      if (!(await getUser(userPhone)) && (await wasAccountDeleted(userPhone))) {
        res.status(401).json({ error: 'no_account', message: 'This account no longer exists.' });
        return;
      }
      const state = deriveConsentState(await getConsents(userPhone));
      res.json(buildConsentView(state));
    } catch (err) {
      log.error('GET /me/consent failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.post('/me/consent', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      const grants = (req.body || {}).grants;
      if (grants === null || typeof grants !== 'object' || Array.isArray(grants)) {
        res.status(400).json({ error: 'invalid_grants', message: `Body must be { grants: { ${ALL_PURPOSES.join('?, ')}? } }.` });
        return;
      }
      const entries = Object.entries(grants as Record<string, unknown>);
      if (entries.length === 0) {
        res.status(400).json({ error: 'invalid_grants', message: 'grants must include at least one purpose.' });
        return;
      }
      for (const [purpose, granted] of entries) {
        if (!ALL_PURPOSES.includes(purpose as ConsentPurpose)) {
          res.status(400).json({ error: 'invalid_purpose', message: `Unknown purpose: ${purpose}` });
          return;
        }
        if (typeof granted !== 'boolean') {
          res.status(400).json({ error: 'invalid_grant_value', message: `${purpose} must be true or false.` });
          return;
        }
      }
      // data_processing is REQUIRED — declining it here would silently
      // leave the app with no lawful basis to keep operating for this
      // user while GET /me/consent still reported "fine". Withdrawing an
      // ACTIVE data_processing consent is a deliberate, differently-worded
      // action (POST /me/consent/revoke) so a user never trips it by
      // accident via this bulk-grants endpoint.
      if ((grants as Record<string, unknown>).data_processing === false) {
        res.status(400).json({
          error: 'cannot_decline_required',
          message: 'data_processing is required to use Amaaii and cannot be set to false here. To stop processing, use POST /me/consent/revoke (or contact support to delete your account).',
        });
        return;
      }
      for (const [purpose, granted] of entries) {
        const p = purpose as ConsentPurpose;
        const g = granted as boolean;
        await recordConsent(userPhone, p, g, CONSENT_VERSION);
        await recordAuditSafe({
          actor: userPhone,
          action: 'consent_grant',
          resource: 'consent',
          resourceOwner: userPhone,
          metadata: { purpose: p, granted: g, channel: 'web' },
        });
      }
      const state = deriveConsentState(await getConsents(userPhone));
      res.json(buildConsentView(state));
    } catch (err) {
      log.error('POST /me/consent failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.post('/me/consent/revoke', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      const { purpose } = req.body || {};
      if (!ALL_PURPOSES.includes(purpose as ConsentPurpose)) {
        res.status(400).json({ error: 'invalid_purpose', message: `Unknown purpose: ${purpose}` });
        return;
      }
      await revokeConsent(userPhone, purpose as ConsentPurpose);
      await recordAuditSafe({
        actor: userPhone,
        action: 'consent_revoke',
        resource: 'consent',
        resourceOwner: userPhone,
        metadata: { purpose, channel: 'web' },
      });
      const state = deriveConsentState(await getConsents(userPhone));
      const view = buildConsentView(state);
      if (purpose === 'data_processing') {
        res.json({
          ...view,
          note: "Data processing consent revoked — Amaaii will stop processing your data going forward. Your existing data isn't deleted automatically; contact support, or use data export/delete (coming soon), if you'd like it removed.",
        });
        return;
      }
      res.json(view);
    } catch (err) {
      log.error('POST /me/consent/revoke failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // --- Activity log (P3-D, Kenya DPA transparency) ---------------------------
  // "Who's accessed your data" for the Profile screen. Thin wrapper over
  // the same listAuditForUser() the P3-C export already exposes — this
  // just gives the PWA a way to show a human-readable slice of it
  // without downloading the full export every time. ACTIVITY_LIST_LIMIT
  // is generous enough to cover "recent activity" without approaching
  // EXPORT_AUDIT_LIMIT's effectively-unbounded read above; a user who
  // wants the complete history already has GET /me/export for that.
  const ACTIVITY_LIST_LIMIT = 100;

  app.get('/me/activity', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      // P3-E: same guard as GET /me/consent (see its comment for why the
      // check is "no current row AND was deleted", not wasAccountDeleted
      // alone) — this route reads audit_log directly and never creates a
      // `users` row, but a deleted account's stale token would otherwise
      // still get back its own (deliberately-retained) audit history,
      // including the delete event itself, as if the account were still
      // active.
      if (!(await getUser(userPhone)) && (await wasAccountDeleted(userPhone))) {
        res.status(401).json({ error: 'no_account', message: 'This account no longer exists.' });
        return;
      }
      const events = await listAuditForUser(userPhone, ACTIVITY_LIST_LIMIT);
      // Recorded AFTER the read above (mirrors GET /me, GET /history,
      // GET /me/medical-history) so viewing your activity log doesn't
      // retroactively insert itself into the very list just returned —
      // it'll show up on the NEXT view instead, same as any other read.
      await recordAuditSafe({ actor: userPhone, action: 'read', resource: 'account', resourceOwner: userPhone });
      res.json({ events });
    } catch (err) {
      log.error('GET /me/activity failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

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
      const userPhone = req.userPhone as string;
      const result = await processMessage(userPhone, message, null, { channel: 'web' });
      // No audit row when consentRequired — nothing was actually
      // processed/stored for this turn (see processMessage's "minimum
      // storage" note), so there is no data-access event to log yet.
      if (!result.consentRequired) {
        await recordAuditSafe({
          actor: userPhone,
          action: result.aiUsed ? 'ai_call' : 'write',
          resource: 'conversation',
          resourceOwner: userPhone,
          metadata: { context: result.context, urgencyLevel: result.urgencyLevel },
        });
      }
      res.json({
        response: result.response,
        urgencyLevel: result.urgencyLevel,
        context: result.context,
        ...(result.consentRequired ? { consentRequired: true } : {}),
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
      // P2-B fix: getOrCreate-shaped (not a bare getUser) — a phone that
      // only ever signed in via OTP/demo login (never sent a WhatsApp/
      // chat message, which used to be the only path that created the
      // row via processMessage) previously hit the `!user` placeholder
      // branch forever. See the PUT /me fix below for the write-side
      // half of the same bug.
      //
      // P3-E fix: getUserForRead (not a bare getOrCreateUser) — the
      // latter would silently recreate a blank profile for a phone whose
      // account was deleted, since a stale bearer token issued before
      // DELETE /me/account still verifies fine (tokens are stateless).
      // getUserForRead keeps the P2-B auto-vivify behavior for genuinely
      // new phones but returns undefined for a deleted one instead — see
      // its doc comment in userManager.ts.
      const user = await userManager.getUserForRead(userPhone);
      if (!user) {
        res.status(401).json({ error: 'no_account', message: 'This account no longer exists.' });
        return;
      }
      const todaysJournals = await getTodaysJournals(userPhone);
      const completedToday = todaysJournals.filter((j) => j.completed);
      const lastJournal = todaysJournals[todaysJournals.length - 1] || null;
      await recordAuditSafe({ actor: userPhone, action: 'read', resource: 'profile', resourceOwner: userPhone });
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
      await recordAuditSafe({ actor: userPhone, action: 'write', resource: 'profile', resourceOwner: userPhone, metadata: { fields: Object.keys(updates) } });
      res.json({ user });
    } catch (err) {
      log.error('PUT /me failed', err);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Medical history (Phase D) ---------------------------------------------
  app.get('/me/medical-history', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      const mh = await getMedicalHistory(userPhone);
      await recordAuditSafe({ actor: userPhone, action: 'read', resource: 'medical_history', resourceOwner: userPhone });
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
      await recordAuditSafe({ actor: userPhone, action: 'write', resource: 'medical_history', resourceOwner: userPhone });
      res.json({ medicalHistory: mh, extracted: extracted || null });
    } catch (err) {
      log.error('POST /me/medical-history failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.get('/history', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      const journals = await getJournalHistory(userPhone, 30);
      const days = (journals || []).map((j) => {
        const startTime = formatTime(j.started_at);
        const status = j.completed
          ? (j.completed_at ? `completed at ${formatTime(j.completed_at)}` : 'completed')
          : 'in progress';
        const label = startTime ? `${j.date} · started ${startTime} · ${status}` : `${j.date} · ${status}`;
        return { label, rows: formatJournalRow(j) };
      }).filter((d) => d.rows.length > 0);
      await recordAuditSafe({ actor: userPhone, action: 'read', resource: 'journal', resourceOwner: userPhone });
      res.json({ days });
    } catch (err) {
      log.error('GET /history failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // --- Structured journal check-in form (P2-C) --------------------------------
  // The PWA form's alternative to the WhatsApp free-text journal flow. Writes
  // the same journals-table columns journalManager.ts writes, so weekly
  // summaries / doctor reports / trend computation work unchanged on rows
  // from either source. SAFETY: danger-sign detection ALWAYS runs here too —
  // the form is never a way to bypass triage (see detectDangerSigns call
  // below, mirroring the 'symptoms'/'notes' stages of the WhatsApp flow).
  app.post('/journal/entries', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      const validation = validateJournalEntryInput(req.body);
      if (!validation.ok) {
        res.status(400).json({ error: validation.error, message: validation.message });
        return;
      }
      const { clientEntryId, mood, symptoms, symptomsText, sleepHours, appetite, babyMovement, note } = validation.value;

      const user = await userManager.getOrCreateUser(userPhone);
      const lang = pickLang(user.language);

      // Re-run the SAME regex-based danger-sign detector the WhatsApp
      // free-text stages use, over symptoms + symptomsText + note joined —
      // exactly the fields a mother could disclose something concerning in.
      const dangerScanText = [
        symptoms.map((s) => s.replace(/_/g, ' ')).join(', '),
        symptomsText,
        note,
      ].filter(Boolean).join('. ');
      const danger = detectDangerSigns(dangerScanText);
      const escalation = danger.urgencyLevel === 'critical' || danger.urgencyLevel === 'high'
        ? dangerCopy(danger.urgencyLevel, lang)
        : undefined;
      await auditDangerEscalation(userPhone, danger.urgencyLevel);

      // Idempotency: a replay of the same (phone, clientEntryId) returns
      // the already-saved entry rather than writing a second row. The
      // escalation/urgency in the response is still recomputed from this
      // request's payload so a retried submission doesn't silently drop
      // the safety banner.
      const existing = await findJournalByClientEntryId(userPhone, clientEntryId);
      if (existing) {
        res.status(200).json({
          entry: toJournalEntryView(existing),
          deduped: true,
          urgencyLevel: danger.urgencyLevel,
          ...(escalation ? { escalation } : {}),
        });
        return;
      }

      const physicalSymptoms = buildPhysicalSymptoms(symptoms, symptomsText);
      const patch: JournalPatch = {
        emotional_state: mood,
        physical_symptoms: physicalSymptoms,
        sleep_hours: sleepHours,
        appetite,
        completed: 1,
        completed_at: new Date().toISOString(),
        client_entry_id: clientEntryId,
      };
      if (babyMovement !== undefined) patch.baby_movement_count = babyMovement;
      if (note) patch.special_notes = note;
      if (danger.urgencyLevel === 'critical' || danger.urgencyLevel === 'high') {
        patch.red_flags_detected = JSON.stringify(danger.detectedSigns);
      }

      let journalId: number;
      try {
        journalId = await createOrUpdateJournal(userPhone, patch, null);
      } catch (err) {
        // A genuine race (two concurrent requests for the same brand-new
        // clientEntryId) loses at the DB's UNIQUE index rather than the
        // application-level check above — fall back to the same dedupe
        // response instead of a 500.
        if (isUniqueConstraintError(err)) {
          const raced = await findJournalByClientEntryId(userPhone, clientEntryId);
          if (raced) {
            res.status(200).json({
              entry: toJournalEntryView(raced),
              deduped: true,
              urgencyLevel: danger.urgencyLevel,
              ...(escalation ? { escalation } : {}),
            });
            return;
          }
        }
        throw err;
      }

      const todays = await getTodaysJournals(userPhone);
      const saved = todays.find((j) => j.id === journalId) ?? todays[todays.length - 1];
      await recordAuditSafe({ actor: userPhone, action: 'write', resource: 'journal', resourceOwner: userPhone, metadata: { clientEntryId } });
      res.status(201).json({
        entry: toJournalEntryView(saved),
        deduped: false,
        urgencyLevel: danger.urgencyLevel,
        ...(escalation ? { escalation } : {}),
      });
    } catch (err) {
      log.error('POST /journal/entries failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.get('/journal/today', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      const todays = await getTodaysJournals(userPhone);
      // getTodaysJournals returns oldest-first; the form wants newest-first.
      const entries = todays.slice().reverse().map(toJournalEntryView);
      await recordAuditSafe({ actor: userPhone, action: 'read', resource: 'journal', resourceOwner: userPhone });
      res.json({ entries, count: entries.length });
    } catch (err) {
      log.error('GET /journal/today failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.get('/journal/entries', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      let days = 14;
      const rawDays = req.query.days;
      if (typeof rawDays === 'string' && rawDays.trim() !== '') {
        const parsed = parseInt(rawDays, 10);
        if (!Number.isNaN(parsed) && parsed > 0) days = Math.min(parsed, 90);
      }
      const history = await getJournalHistory(userPhone, days);
      // getJournalHistory is already ordered by date DESC — group while
      // preserving that order (most recent day first).
      const order: string[] = [];
      const byDate = new Map<string, JournalRow[]>();
      for (const row of history) {
        const key = row.date;
        if (!byDate.has(key)) {
          byDate.set(key, []);
          order.push(key);
        }
        byDate.get(key)!.push(row);
      }
      const daysOut = order.map((date) => ({
        date,
        entries: byDate.get(date)!.map(toJournalEntryView),
      }));
      await recordAuditSafe({ actor: userPhone, action: 'read', resource: 'journal', resourceOwner: userPhone });
      res.json({ days: daysOut });
    } catch (err) {
      log.error('GET /journal/entries failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // --- Insights (P2-E) ---------------------------------------------------------
  // Chart-ready aggregates for the PWA Insights tab, computed from the SAME
  // journals table both the WhatsApp flow and the PWA form write to — so
  // check-ins from either source appear in the same series.
  //
  // Window: 14 (default) or 30 days ONLY — these are the two options the
  // UI's segmented control offers; anything else is an honest 400 rather
  // than a silent clamp (this is a chart API with a fixed vocabulary, not
  // a general history export like GET /journal/entries?days=N).
  //
  // Per-day aggregation: multiple check-ins on one day are AVERAGED per
  // metric, and symptoms are union-counted per entry — see
  // computeDailySeries / computeSymptomCounts in packages/core/src/trend.ts
  // for the full rationale. Series include every recorded observation
  // (even from a check-in that was interrupted before completion — e.g. a
  // danger-sign escalation ends the WhatsApp flow early without setting
  // completed=1, but the mood already given that morning is real data),
  // while `trend` keeps computeTrend's long-standing completed-only
  // averages and `checkinsCount` counts completed check-ins (mirroring
  // GET /me's todayCheckinCount semantics).
  // `/insights` is BOTH the Insights tab's exported page (out/insights.html)
  // AND this JSON API — the one page-vs-API GET collision in this app (see
  // apps/web/next.config.ts's beforeFiles rewrite, which solves the same
  // collision for `next dev` the same way: gate on a header). A plain
  // browser navigation carries neither header, so it falls through
  // (`next('route')`) past requireAuth/the handler below to the static
  // export serving further down, which resolves it to insights.html. An
  // API call always sets X-Amaaii-Api (apps/web/src/lib/api.ts's
  // authedFetch), and/or already carries the bearer token — either is
  // enough to route it to the JSON handler instead.
  app.get(
    '/insights',
    (req: Request, res: Response, next: NextFunction) => {
      const isApiCall = req.get('X-Amaaii-Api') === '1' || !!req.get('authorization');
      if (isApiCall) {
        next();
        return;
      }
      next('route');
    },
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const userPhone = req.userPhone as string;
        let days = 14;
        const rawDays = req.query.days;
        if (rawDays !== undefined) {
          if (rawDays !== '14' && rawDays !== '30') {
            res.status(400).json({ error: 'invalid_days', message: 'days must be 14 or 30.' });
            return;
          }
          days = parseInt(rawDays, 10);
        }
        const journals = await getJournalHistory(userPhone, days);
        await recordAuditSafe({ actor: userPhone, action: 'read', resource: 'insights', resourceOwner: userPhone });
        res.json({
          window: days,
          checkinsCount: (journals || []).filter((j) => !!j.completed).length,
          trend: computeTrend(journals, days),
          moodSeries: computeDailySeries(journals, (j) => j.emotional_state),
          sleepSeries: computeDailySeries(journals, (j) => j.sleep_hours),
          symptomCounts: computeSymptomCounts(journals, 6),
          redFlagDates: computeRedFlagDates(journals),
        });
      } catch (err) {
        log.error('GET /insights failed', err);
        res.status(500).json({ error: 'internal_error' });
      }
    }
  );

  // --- Data-subject rights (P3-C, Kenya DPA) -----------------------------------
  // Server-side halves of the two core DPA rights: portability (export)
  // and erasure (delete). The PWA UI for these ships in P3-D — these
  // routes are usable today via curl/Postman/etc.

  // Effectively-unbounded LIMIT for the audit-log read inside an export:
  // GET /me/export needs the data subject's COMPLETE access history, not
  // listAuditForUser's normal page-sized default. No real user will ever
  // approach this many rows.
  const EXPORT_AUDIT_LIMIT = 1_000_000;

  // GET /me/export — data portability. Gathers every table this user's
  // phone appears in (except otp_codes, which is short-lived auth
  // material, not portable "data about you") into one JSON document and
  // hands it back as a downloadable attachment.
  app.get('/me/export', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      // getUserForRead mirrors GET /me's own fix (P2-B auto-vivify for a
      // genuinely new phone, P3-E no-resurrect for a deleted one) — see
      // userManager.ts's doc comment. A phone that only ever signed in
      // (never chatted, never journaled) still gets a real profile
      // object here instead of a 500; a deleted phone gets a clean 401
      // instead of an export of a just-recreated blank account.
      const user = await userManager.getUserForRead(userPhone);
      if (!user) {
        res.status(401).json({ error: 'no_account', message: 'This account no longer exists.' });
        return;
      }
      const [consents, conversations, journals, symptoms, ancVisits, medicalHistory] = await Promise.all([
        getConsents(userPhone),
        getAllConversationsForUser(userPhone),
        getAllJournalsForUser(userPhone),
        getAllSymptomsForUser(userPhone),
        getAllAncVisitsForUser(userPhone),
        getMedicalHistory(userPhone),
      ]);

      // Audit BEFORE returning — and BEFORE the final audit-log read
      // below, so this very export event is itself part of the
      // "complete access history" the export hands back.
      await recordAuditSafe({
        actor: userPhone,
        action: 'export',
        resource: 'account',
        resourceOwner: userPhone,
      });
      const auditLog = await listAuditForUser(userPhone, EXPORT_AUDIT_LIMIT);

      const exportedAt = new Date().toISOString();
      // `isNewUser` is a transient flag getOrCreateUser() stamps onto the
      // in-memory object for THIS call, not a persisted column — strip it
      // so `profile` is exactly the users-table row (phone_number, name,
      // age, pregnancy_week, edd, location, risk_level, lmp, anc_visits,
      // language, created_at, updated_at).
      const { isNewUser: _isNewUser, ...profile } = user;
      const filenameDate = exportedAt.slice(0, 10);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="amaaii-my-data-${filenameDate}.json"`
      );
      res.json({
        exportedAt,
        phone: userPhone,
        profile,
        consents,
        conversations,
        journals,
        symptoms,
        ancVisits,
        medicalHistory,
        auditLog,
      });
    } catch (err) {
      log.error('GET /me/export failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // DELETE /me/account — erasure. Irreversible: hard-deletes every row
  // this phone owns (see eraseUser()'s doc comment in
  // packages/core/src/repositories.ts for the full table list and why
  // audit_log is the one deliberate exception). Idempotent by
  // construction — eraseUser() against a phone with nothing left simply
  // deletes zero rows from each table, which is not an error.
  app.delete('/me/account', requireAuth, async (req: Request, res: Response) => {
    try {
      const userPhone = req.userPhone as string;
      // SAFETY: this endpoint erases ONLY the authenticated caller's own
      // phone, taken from the verified bearer token — never a phone from
      // the request body. That's a hard invariant (the body is never
      // even read for a phone below), enforced defensively here by
      // rejecting outright if the body tries to supply one — so a caller
      // can never be under the impression a body-supplied phone did
      // anything, successfully or otherwise.
      if (req.body && typeof req.body === 'object' && 'phone' in (req.body as Record<string, unknown>)) {
        res.status(400).json({
          error: 'phone_not_accepted',
          message: 'DELETE /me/account always deletes the authenticated caller’s own account (from the bearer token); it never accepts a phone in the request body.',
        });
        return;
      }
      // Audit FIRST, before the erasure below removes the data (including
      // the consent ledger) this event refers to — see eraseUser()'s doc
      // comment for why audit_log itself survives the erasure.
      await recordAuditSafe({
        actor: userPhone,
        action: 'delete',
        resource: 'account',
        resourceOwner: userPhone,
      });
      await eraseUser(userPhone);
      res.status(200).json({
        deleted: true,
        message: 'Your Amaaii account and data have been permanently deleted.',
      });
    } catch (err) {
      log.error('DELETE /me/account failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // --- Provider portal (P5-A, Stage B demo slice) ------------------------------
  // Hospital/facility staff login + a read-only patient panel. Entirely
  // separate auth namespace from the mother-facing token (see
  // providerAuth.ts's header) — a provider token can never authenticate a
  // mother route (requireAuth above rejects a `provider:`-prefixed sub)
  // and a mother token can never authenticate a route below
  // (requireProviderAuth only accepts a `provider:`-prefixed sub).
  //
  // CONSENT IS THE GATE, NOT ENROLLMENT. Enrolling a mother into a
  // facility's ANC bundle (POST /provider/enroll) never grants that
  // facility (or any facility) access to her clinical data by itself —
  // see consent.ts's header for why a hospital is an independent DPA
  // "controller" that needs her own affirmative 'provider_access'
  // consent, distinct from the app's own data_processing/ai_responses
  // purposes. She grants/revokes it through the SAME /me/consent and
  // /me/consent/revoke endpoints every other purpose already uses
  // (ALL_PURPOSES above already includes 'provider_access' now that it's
  // in consent.ts's OPTIONAL_PURPOSES) — no new mother-facing endpoint
  // was needed for this.
  //
  // provider_access is a single, facility-agnostic flag on the MOTHER's
  // own consent ledger (not scoped per-hospital) — matching the P5 spec's
  // PatientDetail contract exactly ("provider_access ... Gates a
  // healthcare provider's ability to see this mother's clinical record",
  // singular). A provider can only ever reach a mother's record through
  // GET /provider/patients/detail's enrollment boundary check below
  // though, so in practice "any provider" always means "any provider at
  // a facility she's actually enrolled at" — not literally every
  // provider account in the system.

  // Mother's FIRST name only — matches redaction.ts's FIRST-NAME POLICY
  // (see that file's header) and the identical split done in
  // amaaii.ts's USER_CONTEXT block. A provider never sees a mother's
  // full stored name through this portal.
  function firstNameOf(name: string | null | undefined): string | null {
    if (!name) return null;
    const trimmed = name.trim();
    return trimmed ? trimmed.split(/\s+/)[0] : null;
  }

  function dateNDaysAgo(days: number): string {
    return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().split('T')[0];
  }

  function isoWithinLastDays(iso: string, days: number): boolean {
    return new Date(iso).getTime() >= Date.now() - days * 24 * 3600 * 1000;
  }

  interface ProviderEscalation {
    urgency: string;
    createdAt: string;
  }

  // Reads the SAME 'danger_escalation' audit rows auditDangerEscalation()
  // already writes (system actor, CRITICAL/HIGH only) — no new triage or
  // aggregation logic, just a read-side reshape for the provider view.
  // `limit` bounds the underlying listAuditForUser scan; recent-enough
  // for demo scale (a mother with more than `limit` TOTAL audit events
  // since her last escalation would need a real backfill job, not a
  // Friday-demo concern).
  async function fetchRecentEscalations(phone: string, limit = 100): Promise<ProviderEscalation[]> {
    const events = await listAuditForUser(phone, limit);
    return events
      .filter((e) => e.action === 'danger_escalation')
      .map((e) => {
        let urgency = 'unknown';
        try {
          const meta = e.metadata ? JSON.parse(e.metadata) : null;
          if (meta && typeof meta.urgencyLevel === 'string') urgency = meta.urgencyLevel;
        } catch (_) {
          /* leave 'unknown' rather than fail the whole panel/detail read */
        }
        return { urgency, createdAt: e.created_at };
      });
  }

  // Derived, not read from users.risk_level — that column exists in the
  // schema but nothing in this codebase ever writes it (it's always the
  // 'low' default), so surfacing it verbatim would show "low" for every
  // mother regardless of her actual recent history. This rolls up the
  // SAME danger-escalation audit trail and red-flag journal data every
  // other part of the app already produces — reused, not reinvented.
  function computeProviderRiskLevel(
    trend: ReturnType<typeof computeTrend>,
    recentEscalations: ProviderEscalation[]
  ): 'high' | 'moderate' | 'low' {
    if (recentEscalations.some((e) => e.urgency === 'critical')) return 'high';
    if (recentEscalations.length > 0) return 'moderate';
    if (trend && trend.redFlagDays > 0) return 'moderate';
    return 'low';
  }

  const PANEL_TREND_WINDOW_DAYS = 7;
  const DETAIL_TREND_WINDOW_DAYS = 14;

  // One PanelRow. Enrollment metadata (phone/displayName/enrolledAt/
  // status/consentGranted) is ALWAYS included — see the spec's PanelRow
  // shape: it's safe to show without consent. Clinical fields
  // (pregnancyWeek/riskLevel/lastCheckInAt/redFlags7d) are added ONLY
  // when provider_access is actively granted.
  async function buildPatientPanelRow(
    enrollment: { user_phone: string; enrolled_at: string; status: string },
    providerId: number,
    facilityId: number
  ): Promise<Record<string, unknown>> {
    const phone = enrollment.user_phone;
    const [user, consentRows] = await Promise.all([getUser(phone), getConsents(phone)]);
    const consentGranted = hasActiveConsent(deriveConsentState(consentRows), 'provider_access');

    const row: Record<string, unknown> = {
      phone,
      displayName: firstNameOf(user?.name),
      enrolledAt: enrollment.enrolled_at,
      status: enrollment.status,
      consentGranted,
    };

    if (consentGranted) {
      const journals = await getJournalHistory(phone, PANEL_TREND_WINDOW_DAYS);
      const trend = computeTrend(journals, PANEL_TREND_WINDOW_DAYS);
      const escalations = (await fetchRecentEscalations(phone)).filter((e) =>
        isoWithinLastDays(e.createdAt, PANEL_TREND_WINDOW_DAYS)
      );
      const pregnancyWeek = user?.pregnancy_week ?? null;
      const riskLevel = computeProviderRiskLevel(trend, escalations);
      const redFlags7d = trend ? trend.redFlagDays : 0;
      // journals is already ordered by date DESC (getJournalHistory) —
      // [0] is the most recent day within the window; a mother whose
      // last check-in predates the window simply reads null here rather
      // than a stale, potentially-misleading date.
      const lastCheckInAt = journals[0] ? (journals[0].completed_at ?? journals[0].started_at ?? null) : null;
      const ancVisits = user?.anc_visits ?? null;

      row.pregnancyWeek = pregnancyWeek;
      row.riskLevel = riskLevel;
      row.redFlags7d = redFlags7d;
      row.lastCheckInAt = lastCheckInAt;
      row.ancVisits = ancVisits;

      // P6: triage ordering (packages/core/src/triage.ts) — pure, given
      // exactly the fields already computed above. `new Date()` (not a
      // stored/reused clock) is fine here: this is a single synchronous
      // computation inside an already-in-flight request, not a
      // long-running process where the clock could drift mid-call.
      const triage = assessTriage({ redFlags7d, riskLevel, lastCheckInAt, pregnancyWeek, ancVisits }, new Date());
      row.triage = { band: triage.band, score: triage.score, reasons: triage.reasons };
    }

    // Every provider read is audited, regardless of consent outcome —
    // even the metadata-only row (phone + first name) is a read of this
    // mother's data. resource is 'insights' when clinical fields were
    // included, 'profile' when only enrollment metadata was — mirrors
    // GET /provider/patients/detail's own resource choice below.
    await recordAuditSafe({
      actor: `provider:${providerId}`,
      action: 'read',
      resource: consentGranted ? 'insights' : 'profile',
      resourceOwner: phone,
      metadata: { facilityId, consentGranted },
    });

    return row;
  }

  app.post('/provider/auth/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body || {};
      if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
        res.status(400).json({ error: 'invalid_credentials', message: 'email and password are required.' });
        return;
      }
      const provider = await getProviderByEmail(email.trim().toLowerCase());
      // Deliberately identical 401 for "no such provider" and "wrong
      // password" — same anti-enumeration shape as the mother OTP
      // verify flow's wrong-code response, minus the attempts-remaining
      // detail (provider login has no rate-limit/lockout policy for the
      // Friday slice — see the P5 spec's "Out of scope" section).
      if (!provider || !providerAuth.verifyPassword(password, provider.password_hash)) {
        res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect email or password.' });
        return;
      }
      const facility = await getFacility(provider.facility_id);
      if (!facility) {
        // Data-integrity edge case (a provider row whose facility_id
        // doesn't resolve), not a caller error.
        log.error('Provider login: facility_id does not resolve to a facility row', undefined, {
          providerId: provider.id,
          facilityId: provider.facility_id,
        });
        res.status(500).json({ error: 'internal_error' });
        return;
      }
      const token = providerAuth.issueProviderToken(provider.id, provider.facility_id, provider.role);
      res.json({
        token,
        provider: {
          id: provider.id,
          name: provider.name,
          role: provider.role,
          facility: { id: facility.id, name: facility.name, code: facility.code },
        },
      });
    } catch (err) {
      log.error('POST /provider/auth/login failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.get('/provider/summary', requireProviderAuth, async (req: Request, res: Response) => {
    try {
      const facilityId = req.facilityId as number;
      const enrollments = await getEnrollmentsByFacility(facilityId);
      const active = enrollments.filter((e) => e.status === 'active');
      // price_kes is the ANNUAL per-mother subscription price (see its
      // doc comment in packages/core/src/repositories.ts and the
      // `enrollments` table comment in connection.ts) — Ksh 5,000/year
      // per the shareholder pricing model this demo exists to validate,
      // NOT a monthly figure. Sum it directly for the annual total; only
      // monthlyRevenueKes needs the /12 division. Getting this backwards
      // (treating price_kes as monthly and multiplying by 12) overstates
      // annual revenue 12x — exactly the bug this comment exists to
      // prevent a future reader from reintroducing.
      const annualRevenueKes = active.reduce((sum, e) => sum + e.price_kes, 0);
      const monthlyRevenueKes = Math.round(annualRevenueKes / 12);

      // escalations7d: danger_escalation audit events in the last 7 days,
      // counted ONLY across mothers with an ACTIVE provider_access
      // consent — NOT every actively enrolled mother.
      //
      // PRIVACY FIX (P6): the pre-P6 version of this line counted across
      // every active enrollment regardless of consent, on the argument
      // that nothing mother-identifiable is returned in this response
      // (just a total). That argument fails at small N: on a 4-mother
      // panel where one mother hasn't consented, a count that moves
      // while every CONSENTING mother shows no flags identifies the
      // non-consenting one by elimination — exactly the kind of
      // small-cell re-identification GET /provider/cohort's
      // MIN_COHORT_N suppression exists to prevent, just via a single
      // scalar instead of a full aggregate. See CLAUDE.md /
      // packages/core/src/consent.ts: a mother who has not granted
      // provider_access contributes NOTHING the facility can see — not
      // a row, not a statistic, not a count. That rule now applies here
      // too, same as it already did for /provider/patients and
      // /provider/patients/detail.
      //
      // Still no per-mother audit row: this loop reads each consenting
      // mother's escalation history only to fold it into ONE aggregate
      // total, and the response carries no per-mother identifiable data
      // — same rationale as before the fix, now correctly SCOPED to
      // consenting mothers only. A non-consenting mother's escalation
      // history is never read at all here (the consent check below
      // short-circuits before fetchRecentEscalations is ever called for
      // her), so there is nothing to audit on her behalf either.
      const perPatientCounts = await Promise.all(
        active.map(async (e) => {
          const consentState = deriveConsentState(await getConsents(e.user_phone));
          if (!hasActiveConsent(consentState, 'provider_access')) return 0;
          const escalations = await fetchRecentEscalations(e.user_phone);
          return escalations.filter((ev) => isoWithinLastDays(ev.createdAt, 7)).length;
        })
      );
      const escalations7d = perPatientCounts.reduce((a, b) => a + b, 0);

      res.json({
        enrolledCount: enrollments.length,
        activeCount: active.length,
        monthlyRevenueKes,
        annualRevenueKes,
        escalations7d,
      });
    } catch (err) {
      log.error('GET /provider/summary failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.get('/provider/patients', requireProviderAuth, async (req: Request, res: Response) => {
    try {
      const providerId = req.providerId as number;
      const facilityId = req.facilityId as number;
      const enrollments = await getEnrollmentsByFacility(facilityId);
      const patients = await Promise.all(
        enrollments.map((e) => buildPatientPanelRow(e, providerId, facilityId))
      );
      res.json({ patients });
    } catch (err) {
      log.error('GET /provider/patients failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.get('/provider/patients/detail', requireProviderAuth, async (req: Request, res: Response) => {
    try {
      const providerId = req.providerId as number;
      const facilityId = req.facilityId as number;
      const rawPhone = req.query.phone;
      if (typeof rawPhone !== 'string' || rawPhone.trim().length === 0) {
        res.status(400).json({ error: 'invalid_phone', message: 'phone query parameter is required.' });
        return;
      }
      const phone = rawPhone.trim();

      // Boundary check: a provider may only look up phones enrolled at
      // THEIR OWN facility — enrollment is what puts a mother "in their
      // panel" at all. Without this, a provider with a phone number in
      // hand could probe consent status (403 vs 200) for any mother in
      // the whole database, enrolled or not.
      const enrollment = await getEnrollment(facilityId, phone);
      if (!enrollment) {
        res.status(404).json({ error: 'not_enrolled', message: 'This mother is not enrolled at your facility.' });
        return;
      }

      const consentState = deriveConsentState(await getConsents(phone));
      if (!hasActiveConsent(consentState, 'provider_access')) {
        // Audited too — a denied access attempt is still something a
        // mother should be able to see in her own activity log (the
        // differentiator the demo wants to show). resource stays
        // 'profile' (not 'insights') since no clinical data was actually
        // read here.
        await recordAuditSafe({
          actor: `provider:${providerId}`,
          action: 'read',
          resource: 'profile',
          resourceOwner: phone,
          metadata: { facilityId, denied: true, reason: 'no_provider_consent' },
        });
        res.status(403).json({
          error: 'no_provider_consent',
          message: "This mother hasn't granted your facility access to her record.",
        });
        return;
      }

      const user = await getUser(phone);
      const journals = await getJournalHistory(phone, DETAIL_TREND_WINDOW_DAYS);
      const trend = computeTrend(journals, DETAIL_TREND_WINDOW_DAYS);
      const escalations = await fetchRecentEscalations(phone);
      const riskEscalations = escalations.filter((e) => isoWithinLastDays(e.createdAt, DETAIL_TREND_WINDOW_DAYS));

      await recordAuditSafe({
        actor: `provider:${providerId}`,
        action: 'read',
        resource: 'insights',
        resourceOwner: phone,
        metadata: { facilityId },
      });

      res.json({
        phone,
        displayName: firstNameOf(user?.name),
        pregnancyWeek: user?.pregnancy_week ?? null,
        edd: user?.edd ?? null,
        riskLevel: computeProviderRiskLevel(trend, riskEscalations),
        trend,
        // Nested under one `dailySeries` key (rather than two top-level
        // keys the way GET /insights does) to match the P5 spec's
        // PatientDetail shape literally — still just two
        // computeDailySeries() calls, no new aggregation logic.
        dailySeries: {
          moodSeries: computeDailySeries(journals, (j) => j.emotional_state),
          sleepSeries: computeDailySeries(journals, (j) => j.sleep_hours),
        },
        symptomCounts: computeSymptomCounts(journals, 6),
        redFlagDates: computeRedFlagDates(journals),
        recentEscalations: escalations,
      });
    } catch (err) {
      log.error('GET /provider/patients/detail failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.post('/provider/enroll', requireProviderAuth, async (req: Request, res: Response) => {
    try {
      const providerId = req.providerId as number;
      const facilityId = req.facilityId as number;
      const { phone: rawPhone, name } = req.body || {};
      const phone = auth.normalizePhone(rawPhone);
      if (!phone) {
        res.status(400).json({ error: 'invalid_phone', message: 'Please provide a valid phone number.' });
        return;
      }
      if (name !== undefined && name !== null && typeof name !== 'string') {
        res.status(400).json({ error: 'invalid_name', message: 'name must be a string.' });
        return;
      }

      // getOrCreate, not a bare getUser — a hospital may enroll a mother
      // BEFORE she has ever messaged the WhatsApp bot or opened the PWA
      // (same "the profile row must exist before anything else touches
      // it" pattern as PUT /me and POST /journal/entries above). If
      // `name` is supplied and the row doesn't already have one, fill it
      // in — her own later input (onboarding, PUT /me) always wins over
      // this, since this only fills a gap, never overwrites.
      const user = await userManager.getOrCreateUser(phone);
      if (name && !user.name) {
        await updateUser(phone, { name: (name as string).trim() });
      }

      const existingEnrollment = await getEnrollment(facilityId, phone);
      await enrollPatient({ facilityId, userPhone: phone, enrolledBy: providerId });

      // Enrollment does NOT grant consent — this only reports her
      // CURRENT status; see this section's header comment.
      const consentState = deriveConsentState(await getConsents(phone));
      const consentStatus = {
        purpose: 'provider_access' as const,
        granted: hasActiveConsent(consentState, 'provider_access'),
      };

      await recordAuditSafe({
        actor: `provider:${providerId}`,
        action: 'write',
        resource: 'profile',
        resourceOwner: phone,
        metadata: { facilityId, event: 'enrollment' },
      });

      res.status(existingEnrollment ? 200 : 201).json({
        enrolled: true,
        consentStatus,
        ...(existingEnrollment ? { alreadyEnrolled: true } : {}),
      });
    } catch (err) {
      log.error('POST /provider/enroll failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // --- Escalation feed (P6, provider triage queue) ----------------------------
  // Reads the SAME 'danger_escalation' audit rows fetchRecentEscalations()
  // already reshapes for the patient panel/detail routes above — this is
  // not a second escalation store, just a facility-wide read across every
  // enrolled-AND-consented mother instead of one mother at a time, joined
  // in memory against this facility's escalation_acks rows.

  interface EscalationFeedItem {
    phone: string;
    displayName: string | null;
    urgency: string;
    createdAt: string;
    acknowledged: boolean;
    acknowledgedBy?: number;
    acknowledgedAt?: string;
  }

  app.get(
    '/provider/escalations',
  // PAGE-vs-API COLLISION — same shape as /insights above, and the same fix.
  // `/provider/escalations` is BOTH an exported page (out/provider/escalations.html, the provider
  // portal's Escalations tab) and this JSON API. Without this gate a plain
  // browser navigation — which carries no Authorization header — hit
  // requireProviderAuth and got `401 {"error":"unauthorized"}` rendered as
  // raw JSON instead of the page. Verified against a real navigation, not
  // reasoned about: clicking the nav link returned application/json.
  // An API call always sets X-Amaaii-Api (apps/web/src/lib/providerApi.ts)
  // and/or carries the bearer token; anything else falls through
  // (`next('route')`) to the static export further down.
  (req: Request, res: Response, next: NextFunction) => {
    const isApiCall = req.get('X-Amaaii-Api') === '1' || !!req.get('authorization');
    if (isApiCall) {
      next();
      return;
    }
    next('route');
  },
    requireProviderAuth,
    async (req: Request, res: Response) => {
    try {
      const providerId = req.providerId as number;
      const facilityId = req.facilityId as number;
      const enrollments = await getEnrollmentsByFacility(facilityId);
      const acks = await getEscalationAcksByFacility(facilityId);
      const ackByKey = new Map(acks.map((a) => [`${a.userPhone}::${a.escalationAt}`, a]));

      const items: EscalationFeedItem[] = [];
      for (const enrollment of enrollments) {
        const phone = enrollment.user_phone;
        const consentState = deriveConsentState(await getConsents(phone));
        if (!hasActiveConsent(consentState, 'provider_access')) {
          // CONSENT GATES EVERYTHING CLINICAL, including this feed: a
          // non-consenting mother contributes NOTHING here — not even a
          // "she has escalations but you can't see them" placeholder.
          // Still audited (denied, resource 'profile', same shape as GET
          // /provider/patients/detail's 403 branch) so she can see in
          // her own activity log that a provider's escalation feed
          // checked and was blocked — the same transparency guarantee
          // that route already gives a denied clinical read.
          await recordAuditSafe({
            actor: `provider:${providerId}`,
            action: 'read',
            resource: 'profile',
            resourceOwner: phone,
            metadata: { facilityId, denied: true, reason: 'no_provider_consent', context: 'escalation_feed' },
          });
          continue;
        }

        const user = await getUser(phone);
        const escalations = await fetchRecentEscalations(phone);
        for (const escalation of escalations) {
          const ack = ackByKey.get(`${phone}::${escalation.createdAt}`);
          items.push({
            phone,
            displayName: firstNameOf(user?.name),
            urgency: escalation.urgency,
            createdAt: escalation.createdAt,
            acknowledged: !!ack,
            ...(ack ? { acknowledgedBy: ack.acknowledgedBy, acknowledgedAt: ack.acknowledgedAt } : {}),
          });
        }
        // One audit row per consented mother whose escalation history was
        // read (even if she currently has zero escalations — her history
        // was still queried) — mirrors buildPatientPanelRow's per-row
        // audit above.
        await recordAuditSafe({
          actor: `provider:${providerId}`,
          action: 'read',
          resource: 'insights',
          resourceOwner: phone,
          metadata: { facilityId, context: 'escalation_feed' },
        });
      }

      // Newest first — ISO 8601 timestamps sort lexicographically in
      // chronological order, so a plain string comparison is enough.
      items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      res.json({ escalations: items });
    } catch (err) {
      log.error('GET /provider/escalations failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  app.post('/provider/escalations/ack', requireProviderAuth, async (req: Request, res: Response) => {
    try {
      const providerId = req.providerId as number;
      const facilityId = req.facilityId as number;
      const { phone: rawPhone, escalationAt } = req.body || {};
      if (typeof rawPhone !== 'string' || rawPhone.trim().length === 0) {
        res.status(400).json({ error: 'invalid_phone', message: 'phone is required.' });
        return;
      }
      if (typeof escalationAt !== 'string' || escalationAt.trim().length === 0) {
        res.status(400).json({ error: 'invalid_escalationAt', message: 'escalationAt is required.' });
        return;
      }
      const phone = rawPhone.trim();

      // Same two-check boundary as GET /provider/patients/detail: enrollment
      // FIRST (a provider may only act on phones in their own panel — see
      // that route's comment for why this order matters), consent SECOND.
      const enrollment = await getEnrollment(facilityId, phone);
      if (!enrollment) {
        res.status(404).json({ error: 'not_enrolled', message: 'This mother is not enrolled at your facility.' });
        return;
      }

      const consentState = deriveConsentState(await getConsents(phone));
      if (!hasActiveConsent(consentState, 'provider_access')) {
        await recordAuditSafe({
          actor: `provider:${providerId}`,
          action: 'read',
          resource: 'profile',
          resourceOwner: phone,
          metadata: { facilityId, denied: true, reason: 'no_provider_consent', context: 'escalation_ack' },
        });
        res.status(403).json({
          error: 'no_provider_consent',
          message: "This mother hasn't granted your facility access to her record.",
        });
        return;
      }

      const ack = await ackEscalation({ facilityId, userPhone: phone, escalationAt: escalationAt.trim(), acknowledgedBy: providerId });
      await recordAuditSafe({
        actor: `provider:${providerId}`,
        action: 'write',
        resource: 'insights',
        resourceOwner: phone,
        metadata: { facilityId, event: 'escalation_ack', escalationAt: ack.escalationAt },
      });
      res.json({ acknowledged: true, acknowledgedBy: ack.acknowledgedBy, acknowledgedAt: ack.acknowledgedAt });
    } catch (err) {
      log.error('POST /provider/escalations/ack failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // --- Cohort analytics (P6, provider triage queue) ---------------------------
  // Aggregate-only — see packages/core/src/cohort.ts's header for why
  // CohortStats is structurally incapable of carrying per-mother data.
  // Same consent scoping as everywhere else in this file: a mother
  // without active provider_access contributes NOTHING here, not even
  // toward the cohort SIZE used to decide whether MIN_COHORT_N
  // suppression kicks in.
  const COHORT_WINDOW_DAYS = 30;

  app.get(
    '/provider/cohort',
  // PAGE-vs-API COLLISION — same shape as /insights above, and the same fix.
  // `/provider/cohort` is BOTH an exported page (out/provider/cohort.html, the provider
  // portal's Cohort tab) and this JSON API. Without this gate a plain
  // browser navigation — which carries no Authorization header — hit
  // requireProviderAuth and got `401 {"error":"unauthorized"}` rendered as
  // raw JSON instead of the page. Verified against a real navigation, not
  // reasoned about: clicking the nav link returned application/json.
  // An API call always sets X-Amaaii-Api (apps/web/src/lib/providerApi.ts)
  // and/or carries the bearer token; anything else falls through
  // (`next('route')`) to the static export further down.
  (req: Request, res: Response, next: NextFunction) => {
    const isApiCall = req.get('X-Amaaii-Api') === '1' || !!req.get('authorization');
    if (isApiCall) {
      next();
      return;
    }
    next('route');
  },
    requireProviderAuth,
    async (req: Request, res: Response) => {
    try {
      const facilityId = req.facilityId as number;
      const enrollments = await getEnrollmentsByFacility(facilityId);
      const active = enrollments.filter((e) => e.status === 'active');

      const motherInputs: CohortMotherInput[] = [];
      for (const enrollment of active) {
        const phone = enrollment.user_phone;
        const consentState = deriveConsentState(await getConsents(phone));
        if (!hasActiveConsent(consentState, 'provider_access')) continue;

        const [user, journals] = await Promise.all([
          getUser(phone),
          getJournalHistory(phone, COHORT_WINDOW_DAYS),
        ]);
        const trend = computeTrend(journals, COHORT_WINDOW_DAYS);
        // journals is DESC-ordered (getJournalHistory) — [0] is the most
        // recent entry within the window, same idiom buildPatientPanelRow
        // uses above for lastCheckInAt.
        const lastCheckInAt = journals[0] ? (journals[0].completed_at ?? journals[0].started_at ?? null) : null;

        motherInputs.push({
          pregnancyWeek: user?.pregnancy_week ?? null,
          ancVisits: user?.anc_visits ?? null,
          avgMood: trend?.avgMood ?? null,
          avgSleepHours: trend?.avgSleepHours ?? null,
          lastCheckInAt,
          hadRedFlag: !!(trend && trend.redFlagDays > 0),
        });
      }

      const result = computeCohortAggregate(motherInputs, new Date());
      // No per-mother audit row: this route never reads or returns a
      // single identifiable field (no phone, no name, no per-row array —
      // see CohortStats/CohortSuppressed in packages/core/src/cohort.ts),
      // same "aggregate-only, nothing to log against one mother"
      // rationale as GET /provider/summary's escalations7d above.
      res.json(result);
    } catch (err) {
      log.error('GET /provider/cohort failed', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // --- Static: the Next.js PWA (apps/web/out) ---------------------------------
  // `public/` (the older vanilla-JS PWA) is retired — this serves the
  // static export in its place. `out/` is a build artifact (gitignored,
  // produced by `pnpm build:web`) and may not exist in dev/CI/smoke
  // contexts that never ran it; when it's missing we still answer GET /
  // with 200 so the root smoke test (scripts/smoke/00-server-boot.sh)
  // stays meaningful, but with an honest plaintext notice instead of
  // pretending the app is there.
  const webOutDir = opts.webOutDirOverride ?? WEB_OUT_DIR;
  const hasWebBuild = fs.existsSync(path.join(webOutDir, 'index.html'));

  if (hasWebBuild) {
    // next.config.ts has no `trailingSlash: true`, so `next build`'s
    // static export writes flat `<route>.html` files (not
    // `<route>/index.html>`) — confirmed empirically against apps/web/out
    // (chat.html, home.html, insights.html, ... plus index.html at the
    // root). This maps an extensionless request path to that file,
    // treating a trailing slash as equivalent to none (`/insights` and
    // `/insights/` both resolve to `insights.html`; `/` resolves to
    // `index.html`).
    //
    // SECURITY: this only ever computes a RELATIVE filename from
    // `req.path` — never an absolute filesystem path joined against
    // `webOutDir` ourselves. `req.path` is not normalized against `..`
    // by Express (that's a browser-navigation behavior, not an HTTP-layer
    // guarantee — a raw client can send `GET /../../../etc/passwd`
    // literally), so building `path.join(webOutDir, someUserPath)` and
    // handing it straight to `sendFile` would let a crafted path escape
    // `webOutDir` and read arbitrary `.html` files off the host, plus
    // leak their existence via the `fs.existsSync` check. Passing the
    // relative name + `{ root: webOutDir }` to `res.sendFile` instead
    // delegates the boundary check to Express's `send` dependency, which
    // resolves the candidate against `root` and rejects (403, surfaced
    // as an error to the callback below) anything that would land
    // outside it — traversal attempts and genuinely-missing files both
    // end up in the same `send404` branch.
    const relativeExportHtmlPath = (urlPath: string): string => {
      const trimmed = urlPath.replace(/\/+$/, '');
      return trimmed === '' ? 'index.html' : `${trimmed.slice(1)}.html`;
    };

    const send404 = (res: Response): void => {
      res.status(404).sendFile('404.html', { root: webOutDir }, (err) => {
        if (err) res.status(404).end();
      });
    };

    // Serves every asset that exists at its exact request path: hashed
    // `_next/static/*` bundles (long, immutable cache — safe because the
    // filename changes on every build), `sw.js` (explicitly `no-cache` so
    // browsers always revalidate and pick up a new service-worker byte
    // stream promptly — see the SW-takeover note in sw.js/CLAUDE.md),
    // images, manifest.webmanifest, the RSC `.txt` payloads, and
    // `index.html` at `/` via the `index` option. Extensionless page
    // routes (`/login`, `/home`, ...) are NOT files at that exact path
    // (they're `<route>.html`), so they fall through this middleware to
    // the mapping fallback below. `express.static` (the `serve-static` /
    // `send` packages) already enforces the same root-boundary discipline
    // internally, so this mount needs no extra traversal handling itself.
    app.use(
      express.static(webOutDir, {
        index: 'index.html',
        setHeaders: (res, filePath) => {
          if (path.basename(filePath) === 'sw.js') {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (filePath.includes(`${path.sep}_next${path.sep}static${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );

    // GET fallback: extensionless route -> exported HTML file, else the
    // export's 404.html with a real 404 status (not a 200 with error
    // copy — smoke/monitoring should be able to tell the difference).
    app.get(/.*/, (req: Request, res: Response) => {
      const urlPath = req.path;
      if (path.extname(urlPath) === '') {
        res.sendFile(relativeExportHtmlPath(urlPath), { root: webOutDir }, (err) => {
          if (err) send404(res);
        });
        return;
      }
      send404(res);
    });
  } else {
    app.get('/', (req: Request, res: Response) => {
      res
        .type('text/plain')
        .status(200)
        .send(
          'Amaaii web build not found. Run `pnpm build:web` (production) or `pnpm dev:web` (development) to build/serve the PWA.'
        );
    });
  }

  // P4-B: global error-handling backstop — MUST be registered last (its
  // 4-arg arity is what makes Express treat it as an error handler at
  // all; registration ORDER is what makes it a backstop rather than
  // intercepting errors meant for something else). See
  // apps/server/src/errorHandler.ts's header for exactly what reaches
  // this in practice.
  app.use(globalErrorHandler);

  return app;
}
