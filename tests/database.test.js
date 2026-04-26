import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'sk-test-dummy';

const db = require('../services/database');

beforeAll(async () => {
  await db.initializeDatabase();
});

let counter = 8000;
function nextPhone() {
  counter += 1;
  return `whatsapp:+254700008${counter}`;
}

describe('createUser — partial updates preserve fields', () => {
  it('a second createUser with a partial payload does not null out earlier fields', async () => {
    const phone = nextPhone();
    await db.createUser(phone, { name: 'Alpha', age: 30 });
    await db.createUser(phone, { location: 'Nairobi' });
    const u = await db.getUser(phone);
    expect(u.name).toBe('Alpha');
    expect(u.age).toBe(30);
    expect(u.location).toBe('Nairobi');
  });
});

describe('updateUser — whitelist enforcement', () => {
  it('rejects unknown keys with an Error', async () => {
    const phone = nextPhone();
    await db.createUser(phone, { name: 'Beta' });
    await expect(db.updateUser(phone, { malicious_field: 'x' })).rejects.toThrow();
  });

  it('still accepts whitelisted keys', async () => {
    const phone = nextPhone();
    await db.createUser(phone, { name: 'Gamma' });
    await db.updateUser(phone, { age: 27, location: 'Kisumu' });
    const u = await db.getUser(phone);
    expect(u.age).toBe(27);
    expect(u.location).toBe('Kisumu');
  });
});
