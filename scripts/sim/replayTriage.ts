// Free regression check: replay every mother message from a past sim run
// through the CURRENT deterministic danger engine (no API calls).
// Usage: tsx scripts/sim/replayTriage.ts sim-runs/<run> [--list]
//   recall    = scripted danger beats whose first 2 messages reach >= high
//   falseAlarm = >= high on a message outside any danger beat
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs';
import path from 'path';
import { detectDangerSigns } from '../../packages/core/src/dangerSigns';

const runDir = process.argv[2];
const list = process.argv.includes('--list');
const rank: Record<string, number> = { low: 0, moderate: 1, high: 2, critical: 3 };

let beats = 0, hits = 0, exact = 0, fa = 0, msgs = 0;
const misses: string[] = [];
const alarms: string[] = [];
for (const arm of fs.readdirSync(runDir).filter((d) => ['H', 'S'].includes(d))) {
  for (const pid of fs.readdirSync(path.join(runDir, arm))) {
    const f = path.join(runDir, arm, pid, 'turns.jsonl');
    if (!fs.existsSync(f)) continue;
    const turns = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((t) => t.turn && t.kind !== 'followup_reply' && typeof t.msg === 'string');
    const byBeat = new Map<number, any[]>();
    for (const t of turns) {
      if (!byBeat.has(t.beatIdx)) byBeat.set(t.beatIdx, []);
      byBeat.get(t.beatIdx)!.push(t);
    }
    for (const ts of byBeat.values()) {
      const expect = ts[0].expectDanger as string | null;
      if (expect) {
        beats++;
        const levels = ts.slice(0, 2).map((t) => detectDangerSigns(t.msg).urgencyLevel);
        const max = Math.max(...levels.map((l) => rank[l]));
        if (max >= rank.high) hits++; else misses.push(`${arm} ${pid} ${ts[0].beatAt} want=${expect} got=${levels.join('/')} | ${ts[0].msg.slice(0, 150)}`);
        if (max >= rank[expect]) exact++;
      } else {
        for (const t of ts) {
          msgs++;
          const r = detectDangerSigns(t.msg);
          if (rank[r.urgencyLevel] >= rank.high) {
            fa++;
            alarms.push(`${arm} ${pid} ${t.beatAt} ${r.urgencyLevel} [${r.detectedSigns.map((s) => s.sign).join(', ')}] | ${t.msg.slice(0, 150)}`);
          }
        }
      }
    }
  }
}
console.log(`danger recall (>=high, first 2 msgs): ${hits}/${beats}; exact level: ${exact}/${beats}`);
console.log(`false alarms (>=high outside danger beats): ${fa}/${msgs} messages`);
if (list) {
  console.log('\n--- misses ---\n' + misses.join('\n'));
  console.log('\n--- false alarms ---\n' + alarms.join('\n'));
}
