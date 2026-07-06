import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Registers Node module hooks so this native `require()` can load
// packages/adapters/src/twilio.ts directly, same as `tsx` does for
// `pnpm start`/`pnpm dev`.
require('tsx/cjs');

describe('packages/adapters/src/twilio module load', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER', '');
  });

  it('does not throw when Twilio credentials are unset', () => {
    expect(() => require('../packages/adapters/src/twilio')).not.toThrow();
  });
});
