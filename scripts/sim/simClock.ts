// Simulated clock for the months-long mother simulation.
//
// Amaaii reads time in two independent places, and both must agree:
//  - JS: `new Date()` / `Date.now()` (today's journal, EDD, trend "yesterday",
//    follow-up runAt) -> replaced globally with a Date subclass.
//  - SQLite: `date('now')` / `datetime('now')` inside queries, plus
//    CURRENT_TIMESTAMP / date('now') column DEFAULTs on insert -> query text
//    is rewritten, and rows that took a DEFAULT are back-dated right after
//    their INSERT (before the caller's callback runs, so the same turn
//    already sees the simulated value).
//
// Timers (setTimeout etc.) stay real.

/* eslint-disable @typescript-eslint/no-explicit-any */
const RealDate = Date;
let simMs = RealDate.now();

export function setSimTime(d: Date | number | string): void {
  simMs = new RealDate(d as any).getTime();
}
export function advance(ms: number): void {
  simMs += ms;
}
export function simNow(): Date {
  return new RealDate(simMs);
}
/** 'YYYY-MM-DD HH:MM:SS' (UTC) — the format SQLite's CURRENT_TIMESTAMP uses. */
export function simSqlTs(): string {
  return new RealDate(simMs).toISOString().replace('T', ' ').slice(0, 19);
}
export function simSqlDate(): string {
  return new RealDate(simMs).toISOString().slice(0, 10);
}

class SimDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(simMs);
    else super(...(args as [any]));
  }
  static now(): number {
    return simMs;
  }
}

// Tables whose insert relies on a time DEFAULT, and how to back-date them.
const DEFAULT_FIXUPS: Record<string, () => [string, unknown[]]> = {
  conversations: () => ['UPDATE conversations SET timestamp = ? WHERE rowid = ?', [simSqlTs()]],
  symptoms: () => ['UPDATE symptoms SET timestamp = ? WHERE rowid = ?', [simSqlTs()]],
  users: () => ['UPDATE users SET created_at = ? WHERE rowid = ?', [simSqlTs()]],
  journals: () => ['UPDATE journals SET date = ?, timestamp = ? WHERE rowid = ?', [simSqlDate(), simSqlTs()]],
};

export function installSimClock(): void {
  (globalThis as any).Date = SimDate;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sqlite3 = require('sqlite3');
  const proto = sqlite3.Database.prototype;

  const rewrite = (sql: unknown): unknown => {
    if (typeof sql !== 'string') return sql;
    // Never touch DDL: rewriting `DEFAULT (date('now'))` would freeze the default.
    if (/^\s*(CREATE|ALTER)\b/i.test(sql)) return sql;
    return sql.replace(/'now'/g, `'${simSqlTs()}'`);
  };

  for (const m of ['get', 'all', 'each', 'exec', 'prepare']) {
    const orig = proto[m];
    proto[m] = function (sql: unknown, ...rest: unknown[]) {
      return orig.call(this, rewrite(sql), ...rest);
    };
  }

  const origRun = proto.run;
  proto.run = function (sql: unknown, ...rest: unknown[]) {
    const dbi = this;
    const text = rewrite(sql);
    const m = typeof text === 'string' && text.match(/^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)/i);
    const fix = m ? DEFAULT_FIXUPS[m[1].toLowerCase()] : undefined;
    const cbIdx = rest.length - 1;
    if (fix && typeof rest[cbIdx] === 'function') {
      const cb = rest[cbIdx] as (this: any, err: Error | null) => void;
      rest[cbIdx] = function (this: any, err: Error | null) {
        const stmt = this;
        if (err || !stmt?.lastID) return cb.call(stmt, err);
        const [upd, params] = fix();
        origRun.call(dbi, upd, [...params, stmt.lastID], () => cb.call(stmt, err));
      };
    }
    return origRun.call(this, text, ...rest);
  };
}
