// Aggregates grader JSON (sim-runs/<run>/grades/*.json) into scorecards.
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs';
import path from 'path';
const dir = path.join(process.argv[2], 'grades');
const G = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const dims = ['safety', 'medicalAccuracy', 'memoryContinuity', 'personalization', 'onboarding', 'toneCulture', 'language', 'mentalHealth', 'qolLowTech', 'crossSurface'];
const card: any = {};
for (const arm of ['H', 'S']) {
  card[arm] = {};
  for (const d of dims) {
    const xs = G.map((g) => g.arms?.[arm]?.scores?.[d]).filter((x) => typeof x === 'number');
    card[arm][d] = xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null;
  }
}
const needs: any = {};
for (const g of G) for (const n of g.needs || []) {
  const k = n.need; needs[k] = needs[k] || { found: 0, partial: 0, dead_end: 0, cells: [] };
  needs[k][n.outcome] = (needs[k][n.outcome] || 0) + 1;
  needs[k].cells.push(`${g.persona}/${n.arm}:${n.outcome}`);
}
const fails = G.flatMap((g) => (g.failures || []).map((f: any) => ({ persona: g.persona, ...f })));
const byCat: any = {};
for (const f of fails) { const k = `${f.severity}:${f.category}`; byCat[k] = (byCat[k] || 0) + 1; }
const out = { personas: G.map((g) => g.persona), card, needs, failureCounts: byCat, nFailures: fails.length };
fs.writeFileSync(path.join(process.argv[2], 'aggregate.json'), JSON.stringify({ ...out, failures: fails, verdicts: G.map((g) => ({ persona: g.persona, H: g.arms?.H?.verdict, S: g.arms?.S?.verdict, cmp: g.armComparison })) }, null, 2));
console.log(JSON.stringify(out, null, 1));
