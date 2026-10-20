// Deterministic metrics over a sim run. Usage: tsx scripts/sim/analyze.ts sim-runs/<run>
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs';
import path from 'path';
import { PERSONAS } from './personas';

const runDir = process.argv[2];
const rank: Record<string, number> = { low: 0, moderate: 1, high: 2, critical: 3 };
const FALLBACK = /having trouble processing|^null$|\(no reply\)|try again later/i;
const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const out: any[] = [];
for (const arm of fs.readdirSync(runDir).filter((d) => ['H', 'S'].includes(d))) {
  for (const pid of fs.readdirSync(path.join(runDir, arm))) {
    const dir = path.join(runDir, arm, pid);
    const f = path.join(dir, 'turns.jsonl');
    if (!fs.existsSync(f)) continue;
    const persona = PERSONAS.find((p) => p.id === pid)!;
    const rows = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const turns = rows.filter((r) => r.turn);
    const final = fs.existsSync(path.join(dir, 'final.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'final.json'), 'utf8')) : null;

    // Onboarding
    const done = turns.findIndex((t) => t.stored && t.stored.name && t.stored.age != null && t.stored.week != null && t.stored.location);
    const onb = done >= 0 ? turns[done] : null;
    const trueGA = onb?.true?.ga;
    const onboarding = {
      completed: done >= 0,
      turnsToComplete: done >= 0 ? done + 1 : null,
      storedName: onb?.stored?.name ?? turns.at(-1)?.stored?.name ?? null,
      storedAge: onb?.stored?.age ?? null, trueAge: persona.age,
      storedWeek: onb?.stored?.week ?? null, trueGA: trueGA ?? (onb?.true?.ppDay != null ? `pp${onb.true.ppDay}` : null),
      storedLocation: onb?.stored?.location ?? null,
      consentGranted: (final?.consents || []).some((c: any) => c.purpose === 'data_processing' && c.granted),
    };

    // Danger recall / precision (judged on the first 2 turns of the beat — escalation must be immediate)
    const byBeat = new Map<number, any[]>();
    for (const t of turns.filter((t) => t.kind !== 'followup_reply')) {
      if (!byBeat.has(t.beatIdx)) byBeat.set(t.beatIdx, []);
      byBeat.get(t.beatIdx)!.push(t);
    }
    const danger: any[] = [];
    const benign: any[] = [];
    for (const [idx, ts] of byBeat) {
      const b = persona.beats[idx];
      if (!b) continue;
      const first = ts.slice(0, 2);
      const maxU = Math.max(...first.map((t) => rank[t.urgency] ?? 0));
      const label = Object.keys(rank).find((k) => rank[k] === maxU);
      if (b.danger) danger.push({ at: b.at, expect: b.danger, got: label, hit: maxU >= rank.high, exact: maxU >= rank[b.danger], msg: first[0]?.msg, context: first[0]?.context, surface: first[0]?.surface });
      if (b.benign) benign.push({ at: b.at, got: label, falsePositive: maxU >= rank.high, msg: first[0]?.msg });
    }
    const unexpectedEscalations = turns
      .filter((t) => rank[t.urgency] >= rank.high && !persona.beats[t.beatIdx]?.danger)
      .map((t) => ({ at: t.beatAt, urgency: t.urgency, msg: t.msg }));

    // Stale week: stored week vs truth over time (pregnant turns only)
    const gaps = turns.filter((t) => t.true?.pregnant && t.stored?.week != null).map((t) => t.true.ga - t.stored.week);
    const lastPreg = [...turns].reverse().find((t) => t.true?.pregnant && t.stored?.week != null);
    const ppTurns = turns.filter((t) => t.true && !t.true.pregnant);

    // Robustness
    const fallbacks = turns.filter((t) => FALLBACK.test(String(t.reply || '').trim()));
    const llmErrors = turns.flatMap((t) => (t.llm || []).filter((c: any) => !c.ok || c.empty));
    const aiTurns = turns.filter((t) => (t.llm || []).some((c: any) => (c.max_tokens ?? 0) >= 500));
    // Journal: episodes that ended with a session still open
    const stuck = [...byBeat.values()].filter((ts) => ts.at(-1)?.journalStage).length;
    const journalTurns = turns.filter((t) => t.context === 'journaling');
    const journalOutsideJournalBeats = journalTurns.filter((t) => !['journal', 'cancel_journal'].includes(persona.beats[t.beatIdx]?.need as string)).length;
    const reminders = turns.filter((t) => /daily journal|jarida/i.test(t.reply || '') && t.context !== 'journaling').length;

    // Web / cross-surface
    const web = {
      webTurns: turns.filter((t) => t.surface === 'web').length,
      webConsentRequired: turns.filter((t) => t.webMeta?.consentRequired).length,
      webJournals: rows.filter((r) => r.kind === 'web_journal').map((r) => r.status),
      webViews: rows.filter((r) => r.kind === 'web_view').map((r) => ({ at: r.sim?.slice(0, 10), week: r.me?.user?.pregnancy_week, edd: r.me?.user?.edd, historyCount: r.historyCount })),
    };

    out.push({
      persona: pid, arm, age: persona.age, techLiteracy: persona.techLiteracy,
      turns: turns.length, aborted: final?.aborted ?? 'no final.json',
      onboarding, danger, benign, unexpectedEscalations,
      staleWeek: { meanGap: gaps.length ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : null, lastTrueGA: lastPreg?.true?.ga ?? null, lastStoredWeek: lastPreg?.stored?.week ?? null, postpartumTurns: ppTurns.length },
      finalLanguage: turns.at(-1)?.stored?.language ?? null,
      robustness: { fallbacks: fallbacks.length, fallbackSamples: fallbacks.slice(0, 3).map((t) => t.msg), llmErrors: llmErrors.length, llmErrorSamples: llmErrors.slice(0, 3) },
      latency: { aiP50: pct(aiTurns.map((t) => t.ms), 0.5), aiP95: pct(aiTurns.map((t) => t.ms), 0.95), allP50: pct(turns.map((t) => t.ms), 0.5) },
      journal: { journalTurns: journalTurns.length, journalOutsideJournalBeats, episodesEndedMidJournal: stuck, completedJournals: final?.completedJournals ?? null, reminderNags: reminders },
      followups: rows.filter((r) => r.kind === 'followup_sent').length,
      web,
      cost: { amaaii: final?.amaaiiCost ?? null, mother: final?.motherCost ?? null },
    });
  }
}
fs.writeFileSync(path.join(runDir, 'metrics.json'), JSON.stringify(out, null, 2));

// Compact summary per arm
for (const arm of [...new Set(out.map((o) => o.arm))]) {
  const os = out.filter((o) => o.arm === arm);
  const d = os.flatMap((o) => o.danger);
  const b = os.flatMap((o) => o.benign);
  console.log(`\n=== Arm ${arm} — ${os.length} mothers, ${os.reduce((a, o) => a + o.turns, 0)} turns ===`);
  console.log(`danger recall (>=high): ${d.filter((x) => x.hit).length}/${d.length}; exact level: ${d.filter((x) => x.exact).length}/${d.length}`);
  console.log(`benign false positives: ${b.filter((x) => x.falsePositive).length}/${b.length}; unexpected escalations: ${os.reduce((a, o) => a + o.unexpectedEscalations.length, 0)}`);
  console.log(`onboarding completed: ${os.filter((o) => o.onboarding.completed).length}/${os.length}; median turns: ${pct(os.map((o) => o.onboarding.turnsToComplete).filter(Boolean), 0.5)}`);
  console.log(`fallback replies: ${os.reduce((a, o) => a + o.robustness.fallbacks, 0)}; llm errors/empty: ${os.reduce((a, o) => a + o.robustness.llmErrors, 0)}`);
  console.log(`cost amaaii $${os.reduce((a, o) => a + (o.cost.amaaii || 0), 0).toFixed(2)}, mother $${os.reduce((a, o) => a + (o.cost.mother || 0), 0).toFixed(2)}`);
  for (const o of os) {
    console.log(`  ${o.persona.padEnd(10)} turns=${String(o.turns).padStart(3)} onb=${o.onboarding.turnsToComplete ?? 'X'} name=${JSON.stringify(o.onboarding.storedName)} age=${o.onboarding.storedAge}/${o.age} wk=${o.onboarding.storedWeek}/${o.onboarding.trueGA} lastWk=${o.staleWeek.lastStoredWeek}/${o.staleWeek.lastTrueGA} lang=${o.finalLanguage} danger=${o.danger.map((x: any) => (x.hit ? '✓' : '✗') + x.expect[0]).join('')} fp=${o.benign.filter((x: any) => x.falsePositive).length} stuckJ=${o.journal.episodesEndedMidJournal} fb=${o.robustness.fallbacks} p50=${o.latency.aiP50}ms`);
  }
}
