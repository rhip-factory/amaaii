require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { handleIncomingMessage, processMessage } = require('./utils/messageHandler');
const { initializeDatabase } = require('./services/database');
const { log } = require('./utils/logger');
const twilioSignature = require('./middleware/twilioSignature');

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

// PWA chat endpoint — same brain as the WhatsApp webhook, but the
// response is returned directly instead of going through Twilio. PWA
// users get a separate ID space (pwa:<sessionId>) so they don't collide
// with WhatsApp test users.
app.post('/chat', async (req, res) => {
  try {
    const { sessionId, message, profileName } = req.body || {};
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'message is required' });
    }
    const from = `pwa:${sessionId}`;
    log.info('PWA message received', { sessionId, message, profileName });
    const result = await processMessage(from, message, profileName || null);
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
