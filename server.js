require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { handleIncomingMessage, processMessage } = require('./utils/messageHandler');
const { initializeDatabase, getUser, updateUser, getTodaysJournal, getTodaysJournals, getJournalHistory, getConversationHistory, getMedicalHistory, saveMedicalHistory } = require('./services/database');
const { getRecentTrend } = require('./services/trend');
const llmExtract = require('./services/llmExtract');
const { log } = require('./utils/logger');
const twilioSignature = require('./middleware/twilioSignature');
const auth = require('./services/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Twilio WhatsApp webhook
app.post('/webhook', twilioSignature, async (req, res) => {
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

app.get('/webhook', (req, res) => {
  res.send('WhatsApp Bot Webhook is running!');
});

// --- Auth -----------------------------------------------------------------
// Phase A demo auth: phone-only sign-in, no OTP. Real verification lands
// in Phase 3. The token is HMAC-signed so the client can't forge a phone.
app.post('/auth/login', (req, res) => {
  const { phone } = req.body || {};
  const normalized = auth.normalizePhone(phone);
  if (!normalized) {
    return res.status(400).json({ error: 'invalid_phone', message: 'Please enter a valid phone number.' });
  }
  const token = auth.issueToken(normalized);
  log.info('PWA login', { phone: normalized });
  res.json({ token, user: { phone: normalized } });
});

// Bearer-token middleware. Attaches req.userPhone if a valid token is
// present; rejects with 401 otherwise.
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'missing_token' });
  const payload = auth.verifyToken(m[1]);
  if (!payload || !payload.sub) return res.status(401).json({ error: 'invalid_token' });
  req.userPhone = payload.sub;
  next();
}

// PWA chat endpoint — same brain as the WhatsApp webhook. The user phone
// comes from the auth token; users keyed by `whatsapp:+E.164` so a phone
// that has messaged the WhatsApp sandbox sees its conversation history
// after logging in to the PWA.
app.post('/chat', requireAuth, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'message is required' });
    }
    log.info('PWA message received', { phone: req.userPhone, message });
    const result = await processMessage(req.userPhone, message, null);
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

// --- /me + /history --------------------------------------------------------
const PROFILE_FIELDS = ['name', 'age', 'pregnancy_week', 'location', 'language'];

function trimesterFromWeek(w) {
  if (!w) return null;
  if (w < 13) return 'first trimester';
  if (w < 27) return 'second trimester';
  return 'third trimester';
}

function weekDescription(week) {
  if (!week) return null;
  // Light week-by-week copy. Phase 2 plugs in WHO content.
  const descriptions = [
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
    'Size of a passion fruit; movements you can\'t yet feel.',
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

function tipFor(user, todayJournal) {
  if (!user || !user.pregnancy_week) {
    return { headline: 'Add your pregnancy week', body: 'Once I know how far along you are, the tips and reminders here become much more useful.' };
  }
  if (todayJournal) {
    return { headline: 'Nice work checking in', body: "You've already journaled today. A short walk and a glass of water are two of the best things you can do this week." };
  }
  return { headline: 'Hydration first', body: 'Aim for 8 glasses of water today. Pair it with the daily journal — it takes about two minutes.' };
}

app.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await getUser(req.userPhone);
    if (!user) {
      return res.json({
        user: { phone: req.userPhone },
        todayJournal: null,
        weekDescription: null,
        tip: tipFor(null, null),
      });
    }
    const todaysJournals = await getTodaysJournals(req.userPhone);
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
      trend: await getRecentTrend(req.userPhone, 7),
    });
  } catch (err) {
    log.error('GET /me failed', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.put('/me', requireAuth, async (req, res) => {
  try {
    const updates = {};
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
      const user = await getUser(req.userPhone);
      return res.json({ user });
    }
    await updateUser(req.userPhone, updates);
    const user = await getUser(req.userPhone);
    res.json({ user });
  } catch (err) {
    log.error('PUT /me failed', err);
    res.status(400).json({ error: err.message });
  }
});

function formatJournalRow(j) {
  const rows = [];
  if (j.emotional_state != null) {
    const e = j.emotional_state;
    const emoji = e >= 7 ? '😊' : e >= 5 ? '😐' : '😔';
    rows.push({ label: 'Mood', value: `${e}/10 ${emoji}` });
  }
  if (j.physical_symptoms && j.physical_symptoms !== 'none') {
    let s = j.physical_symptoms;
    if (typeof s === 'string' && s.trim().startsWith('[')) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) s = arr.map(x => String(x).replace(/_/g, ' ')).join(', ');
      } catch (_) {}
    }
    rows.push({ label: 'Symptoms', value: s });
  }
  if (j.sleep_hours != null || j.sleep_quality != null) {
    const parts = [];
    if (j.sleep_quality != null) parts.push(`${j.sleep_quality}/10`);
    if (j.sleep_hours != null) parts.push(`${j.sleep_hours}h`);
    rows.push({ label: 'Sleep', value: parts.join(' · ') });
  }
  if (j.water_intake != null) rows.push({ label: 'Water', value: `${j.water_intake} glasses` });
  if (j.appetite) rows.push({ label: 'Appetite', value: j.appetite });
  if (j.red_flags_detected) rows.push({ label: '⚠️ Flagged', value: j.red_flags_detected });
  if (j.completed_at && j.started_at) {
    const dur = Math.max(1, Math.round((new Date(j.completed_at) - new Date(j.started_at)) / 1000));
    rows.push({ label: 'Duration', value: dur < 60 ? `${dur}s` : `${Math.round(dur / 60)} min` });
  }
  return rows;
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (_) { return ''; }
}

// --- Medical history (Phase D) ---------------------------------------------
app.get('/me/medical-history', requireAuth, async (req, res) => {
  try {
    const mh = await getMedicalHistory(req.userPhone);
    res.json({ medicalHistory: mh });
  } catch (err) {
    log.error('GET /me/medical-history failed', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/me/medical-history', requireAuth, async (req, res) => {
  try {
    const { rawText, overwrite } = req.body || {};
    if (typeof rawText !== 'string') {
      return res.status(400).json({ error: 'rawText is required.' });
    }
    const trimmed = rawText.trim();
    // Min length (20 chars) and word count (≥4) blocks gibberish like "12345"
    // from silently wiping a real record.
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (trimmed.length < 20 || wordCount < 4) {
      return res.status(400).json({
        error: 'rawText too short — please add a few more details.',
      });
    }
    const extracted = await llmExtract.extractMedicalHistory(trimmed);
    const isUseful = extracted && Object.keys(extracted).filter((k) => {
      const v = extracted[k];
      if (Array.isArray(v)) return v.length > 0;
      if (v && typeof v === 'object') return Object.values(v).some((x) => x != null);
      return v != null;
    }).length > 0;
    // If the LLM extracted nothing AND a richer record already exists,
    // refuse the overwrite unless the caller explicitly opts in.
    const existing = await getMedicalHistory(req.userPhone);
    if (!isUseful && existing && existing.rawText && !overwrite) {
      return res.status(409).json({
        error: 'no_extractable_data',
        message: "I couldn't extract any structured info from that. Pass overwrite=true to replace your saved history anyway.",
        currentRecord: existing,
      });
    }
    await saveMedicalHistory(req.userPhone, { rawText: trimmed, extracted: extracted || {} });
    const mh = await getMedicalHistory(req.userPhone);
    res.json({ medicalHistory: mh, extracted: extracted || null });
  } catch (err) {
    log.error('POST /me/medical-history failed', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/history', requireAuth, async (req, res) => {
  try {
    const journals = await getJournalHistory(req.userPhone, 30);
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
app.use(express.static(path.join(__dirname, 'public')));

// Friendly root: serve the PWA when public/index.html exists, otherwise
// fall back to the legacy WhatsApp-only health string.
app.get('/', (req, res, next) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) res.send('WhatsApp Pregnancy Bot Server is running!');
  });
});

async function startServer() {
  try {
    await initializeDatabase();
    log.info('Database initialized successfully');

    app.listen(PORT, () => {
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
