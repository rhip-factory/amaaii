const twilio = require('twilio');
const { log } = require('../utils/logger');

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  cachedClient = twilio(accountSid, authToken);
  return cachedClient;
}

async function sendWhatsAppMessage(to, message) {
  try {
    const response = await getClient().messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
    });

    log.info(`Message sent successfully. SID: ${response.sid}`);
    return response;
  } catch (error) {
    log.error('Error sending WhatsApp message', error);
    throw error;
  }
}

module.exports = { sendWhatsAppMessage, getClient };
