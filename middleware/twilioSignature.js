const twilio = require('twilio');
const { log } = require('../utils/logger');

function shouldEnforce() {
  const flag = process.env.TWILIO_SIGNATURE_ENFORCE;
  if (flag !== undefined && flag !== '') {
    return flag.toLowerCase() === 'true';
  }
  return process.env.NODE_ENV === 'production';
}

function buildUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${req.originalUrl}`;
}

function twilioSignature(req, res, next) {
  const signature = req.header('X-Twilio-Signature');
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  const url = buildUrl(req);
  const params = req.body || {};

  const valid = signature
    ? twilio.validateRequest(authToken, signature, url, params)
    : false;

  if (valid) return next();

  if (shouldEnforce()) {
    log.warn('Rejected webhook: invalid Twilio signature', {
      hasSignature: !!signature,
      url,
    });
    return res.status(403).send('Forbidden');
  }

  log.warn('Twilio signature invalid (enforce=off, allowing)', {
    hasSignature: !!signature,
    url,
  });
  return next();
}

module.exports = twilioSignature;
