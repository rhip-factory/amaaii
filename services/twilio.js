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

async function defaultSend(to, message) {
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

// Test seam: callers (e.g. utils/messageHandler.js) destructure
// `sendWhatsAppMessage` at require time, so we wrap a swappable impl
// behind a stable function reference. Tests call __setSendImpl to inject
// a no-op recorder; reset to defaultSend afterwards.
let _impl = defaultSend;

async function sendWhatsAppMessage(to, message) {
  return _impl(to, message);
}

function __setSendImpl(fn) {
  _impl = fn || defaultSend;
}

function __resetSendImpl() {
  _impl = defaultSend;
}

module.exports = { sendWhatsAppMessage, getClient, __setSendImpl, __resetSendImpl };
