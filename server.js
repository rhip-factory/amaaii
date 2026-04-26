require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { handleIncomingMessage, processMessage } = require('./utils/messageHandler');
const { initializeDatabase } = require('./services/database');
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
