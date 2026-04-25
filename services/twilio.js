const twilio = require('twilio');
const { log } = require('../utils/logger');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

async function sendWhatsAppMessage(to, message) {
  try {
    const response = await client.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to
    });

    log.info(`Message sent successfully. SID: ${response.sid}`);
    return response;
  } catch (error) {
    log.error('Error sending WhatsApp message', error);
    throw error;
  }
}

module.exports = { sendWhatsAppMessage };