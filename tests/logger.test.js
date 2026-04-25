import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { log } from '../utils/logger.js';

describe('logger redaction', () => {
  let stdout;
  let stderr;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  function lastOut() {
    const calls = [...stdout.mock.calls, ...stderr.mock.calls];
    return calls.map((c) => String(c[0])).join('');
  }

  it('redacts whatsapp:+phone pattern in message strings', () => {
    log.info('inbound from whatsapp:+254797437715');
    const out = lastOut();
    expect(out).toContain('[PHONE]');
    expect(out).not.toContain('254797437715');
  });

  it('redacts bare +phone pattern in message strings', () => {
    log.info('called +254797437715 directly');
    const out = lastOut();
    expect(out).toContain('[PHONE]');
    expect(out).not.toContain('254797437715');
  });

  it('redacts name key in ctx', () => {
    log.info('user lookup', { name: 'Grace' });
    const out = lastOut();
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('Grace');
  });

  it('redacts Body key (case-insensitive)', () => {
    log.info('payload', { Body: 'hello' });
    const out = lastOut();
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('hello');
  });

  it('does not redact non-PII keys', () => {
    log.info('triage', { urgencyLevel: 'high', stage: 'mood' });
    const out = lastOut();
    expect(out).toContain('high');
    expect(out).toContain('mood');
    expect(out).not.toContain('[REDACTED]');
  });

  it('traverses nested objects', () => {
    log.info('nested', { user: { name: 'G', age: 26 } });
    const out = lastOut();
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('26');
    expect(out).not.toContain('"G"');
  });

  it('redacts location, profilename, message keys', () => {
    log.info('multi', {
      location: 'Nairobi',
      ProfileName: 'Test',
      message: 'secret',
    });
    const out = lastOut();
    expect(out).not.toContain('Nairobi');
    expect(out).not.toContain('Test');
    expect(out).not.toContain('secret');
  });

  it('handles arrays containing PII', () => {
    log.info('list', { items: [{ name: 'A' }, { name: 'B' }] });
    const out = lastOut();
    expect(out).not.toContain('"A"');
    expect(out).not.toContain('"B"');
    expect(out).toContain('[REDACTED]');
  });

  it('error() accepts (msg, err, ctx)', () => {
    log.error('boom', new Error('detail'), { name: 'Grace' });
    const out = lastOut();
    expect(out).toContain('boom');
    expect(out).toContain('detail');
    expect(out).not.toContain('Grace');
  });

  it('warn() emits at warn level', () => {
    log.warn('careful', { Body: 'x' });
    const out = lastOut();
    expect(out).toContain('careful');
    expect(out).not.toContain('"x"');
  });
});
