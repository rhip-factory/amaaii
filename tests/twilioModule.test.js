import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('services/twilio module load', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER', '');
  });

  it('does not throw when Twilio credentials are unset', () => {
    expect(() => require('../services/twilio')).not.toThrow();
  });
});
