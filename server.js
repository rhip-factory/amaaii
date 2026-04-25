require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { handleIncomingMessage } = require('./utils/messageHandler');
const { initializeDatabase } = require('./services/database');
const { log } = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
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

app.get('/', (req, res) => {
  res.send('WhatsApp Pregnancy Bot Server is running!');
});

async function startServer() {
  try {
    await initializeDatabase();
    log.info('Database initialized successfully');

    app.listen(PORT, () => {
      log.info(`Amaaii WhatsApp Bot Server Started`);
      log.info(`Server is running on port ${PORT}`);
      log.info(`Webhook endpoint: http://localhost:${PORT}/webhook`);
      log.info('Features Enabled', {
        features: [
          'Danger sign detection with escalation',
          'User profile management',
          'Conversation history tracking',
          'Symptom monitoring',
          'Mental health screening',
          'ANC visit tracking',
        ],
      });
      log.info('To expose this server to the internet for Twilio:', {
        steps: [
          'Install ngrok: npm install -g ngrok',
          `Run: ngrok http ${PORT}`,
          'Copy the HTTPS URL and set it in Twilio WhatsApp Sandbox settings',
        ],
      });
    });
  } catch (error) {
    log.error('Failed to start server', error);
    process.exit(1);
  }
}

startServer();
