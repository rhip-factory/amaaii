#!/usr/bin/env bash
set -euo pipefail

node -e "
const { detectDangerSigns } = require('./services/dangerSigns');
const cases = [
  ['my blood pressure was fine at the clinic', 'low'],
  [\"I'm tired of waiting for my ANC appointment\", 'low'],
  [\"I've been drinking fluids all day\", 'low'],
  ['severe headache and seeing spots', 'critical'],
  ['I am bleeding heavily', 'critical'],
  ['I feel so tired and exhausted', 'moderate'],
];
let failed = 0;
for (const [msg, expected] of cases) {
  const { urgencyLevel } = detectDangerSigns(msg);
  if (urgencyLevel !== expected) {
    console.error('FAIL:', JSON.stringify(msg), '-> got', urgencyLevel, 'expected', expected);
    failed++;
  }
}
if (failed) process.exit(1);
console.log('PASS: danger-signs smoke');
"
