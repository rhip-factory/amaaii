require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { handleIncomingMessage } = require('./utils/messageHandler');
const { initializeDatabase } = require('./services/database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  try {
    const { From, Body, ProfileName } = req.body;
    
    console.log(`Received message from ${From} (${ProfileName}): ${Body}`);
    
    await handleIncomingMessage(From, Body, ProfileName);
    
    res.status(200).send('Message received');
  } catch (error) {
    console.error('Error processing message:', error);
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
    console.log('Database initialized successfully');
    
    app.listen(PORT, () => {
      console.log(`\n✅ Amaaii WhatsApp Bot Server Started`);
      console.log(`📍 Server is running on port ${PORT}`);
      console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/webhook`);
      console.log('\n📱 Features Enabled:');
      console.log('  - Danger sign detection with escalation');
      console.log('  - User profile management');
      console.log('  - Conversation history tracking');
      console.log('  - Symptom monitoring');
      console.log('  - Mental health screening');
      console.log('  - ANC visit tracking');
      console.log('\n🌐 To expose this server to the internet for Twilio:');
      console.log(`  1. Install ngrok: npm install -g ngrok`);
      console.log(`  2. Run: ngrok http ${PORT}`);
      console.log('  3. Copy the HTTPS URL and set it in Twilio WhatsApp Sandbox settings\n');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();