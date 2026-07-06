import { describe, it, expect } from 'vitest';
import golden from './fixtures/danger-signs-golden.json' with { type: 'json' };
import { detectDangerSigns } from '@amaaii/core';

describe('detectDangerSigns golden set', () => {
  for (const entry of golden) {
    const label = `[${entry.expected_urgency}] ${entry.message}`;
    it(label, () => {
      const { urgencyLevel } = detectDangerSigns(entry.message);
      expect(urgencyLevel, entry.note).toBe(entry.expected_urgency);
    });
  }
});

describe('required negatives (must resolve to low)', () => {
  const required = [
    'my blood pressure was fine at the clinic',
    "I'm tired of waiting for my ANC appointment",
    "I've been drinking fluids all day",
    'the blood test came back good',
    'not feeling too tired today, actually',
  ];
  for (const msg of required) {
    it(msg, () => {
      const { urgencyLevel } = detectDangerSigns(msg);
      expect(urgencyLevel).toBe('low');
    });
  }
});
