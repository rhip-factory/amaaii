// P4-B: tiny in-process metrics registry for pilot observability — no
// external dependency (no prom-client, no OpenTelemetry SDK; see
// CLAUDE.md's dependency-light style, matching the hand-rolled PII
// redaction / logger / job queue already in this codebase). Exposition
// is Prometheus text format ("# HELP" / "# TYPE" + `name{labels} value`
// lines) — the de-facto pilot-hosting standard, and simple enough to
// hand-roll honestly at this scale (one process, a handful of series).
//
// PII DISCIPLINE (load-bearing, mirrors packages/core/src/redaction.ts's
// header): every label value accepted anywhere in this file comes from
// a closed, small vocabulary the CALLER controls — route TEMPLATES
// (e.g. '/journal/entries', never a raw path with query params or a
// phone number in a path segment), STATUS CLASSES ('2xx'/'4xx'/'5xx',
// never an exact status code), urgency levels ('critical'/'high'), job
// statuses ('pending'/'running'/'done'/'failed'), and a handful of fixed
// OTP outcome strings. Nothing in this module ever accepts a phone
// number, name, or free-text message content as a label or value —
// tests/observability.test.ts's "PII-free" assertion is what actually
// pins this against regressions, not just this comment.
import type { JobStatus } from '@amaaii/core';

type Labels = Record<string, string>;

function serializeLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${labels[k]}"`).join(',')}}`;
}

/** Monotonic counter, keyed by a label-tuple. */
class Counter {
  private values = new Map<string, number>();

  inc(labels: Labels = {}, by = 1): void {
    const key = serializeLabels(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  lines(name: string): string[] {
    return [...this.values.entries()].map(([labelStr, value]) => `${name}${labelStr} ${value}`);
  }

  reset(): void {
    this.values.clear();
  }
}

interface SummaryState {
  count: number;
  sum: number;
  max: number;
}

/** Minimal latency summary — count/sum/max only, no percentiles (no
 *  dependency for histogram bucketing/quantile estimation; see this
 *  file's header). Good enough to compute an average (sum/count) and
 *  spot a worst-case outlier (max) from any Prometheus-compatible
 *  scraper or a human reading /metrics directly. */
class Summary {
  private states = new Map<string, SummaryState>();

  observe(labels: Labels, value: number): void {
    const key = serializeLabels(labels);
    const s = this.states.get(key) ?? { count: 0, sum: 0, max: 0 };
    s.count += 1;
    s.sum += value;
    if (value > s.max) s.max = value;
    this.states.set(key, s);
  }

  lines(name: string): string[] {
    const out: string[] = [];
    for (const [labelStr, s] of this.states.entries()) {
      out.push(`${name}_count${labelStr} ${s.count}`);
      out.push(`${name}_sum${labelStr} ${s.sum.toFixed(3)}`);
      out.push(`${name}_max${labelStr} ${s.max.toFixed(3)}`);
    }
    return out;
  }

  reset(): void {
    this.states.clear();
  }
}

// --- Registries --------------------------------------------------------

const httpRequestsTotal = new Counter();
const httpRequestDurationMs = new Summary();
const httpServerErrorsTotal = new Counter();
const dangerEscalationsTotal = new Counter();
const llmCallsTotal = new Counter();
const llmFailuresTotal = new Counter();
const otpRequestsTotal = new Counter();
const otpVerificationsTotal = new Counter();

// --- Writers -------------------------------------------------------------
// Every call site is documented at its own location; listed here so this
// file doubles as the index of "who is allowed to increment what":
//  - recordHttpRequest        <- middleware/requestObservability.ts (every request, on 'finish')
//  - incrementHttpServerError <- errorHandler.ts (the global backstop only)
//  - incrementDangerEscalation<- audit.ts#auditDangerEscalation (the one funnel every
//                                 CRITICAL/HIGH escalation path already goes through)
//  - incrementLlmCall/Failure <- packages/adapters/src/llm.ts#chat (the single LLM
//                                 chokepoint — see CLAUDE.md's single-chokepoint rule)
//  - incrementOtpRequest/Verification <- app.ts's /auth/otp/request + /auth/otp/verify

/** `method`: HTTP verb. `route`: matched Express route TEMPLATE (e.g.
 *  '/journal/entries') or 'other' for anything unmatched (static PWA
 *  assets, the extensionless-route fallback, 404s) — never a raw path
 *  with ids/query. `statusClass`: 'Nxx' bucket, never the exact code. */
export function recordHttpRequest(method: string, route: string, statusClass: string, durationMs: number): void {
  const labels = { method, route, status_class: statusClass };
  httpRequestsTotal.inc(labels);
  httpRequestDurationMs.observe(labels, durationMs);
}

/** Distinct from the general http_requests_total{status_class="5xx"}
 *  bucket (which also counts routes that deliberately res.status(500)
 *  their own already-handled failures — most routes in this app do):
 *  this one counts only requests that reached the GLOBAL error-handling
 *  backstop, i.e. something actually threw/rejected uncaught. */
export function incrementHttpServerError(route: string): void {
  httpServerErrorsTotal.inc({ route });
}

/** Only ever called for 'critical' | 'high' urgency. */
export function incrementDangerEscalation(urgency: 'critical' | 'high'): void {
  dangerEscalationsTotal.inc({ urgency });
}

export function incrementLlmCall(): void {
  llmCallsTotal.inc();
}

export function incrementLlmFailure(): void {
  llmFailuresTotal.inc();
}

/** `result` is a small fixed vocabulary the caller already branches on
 *  for its own HTTP response (e.g. 'sent' | 'dev_mode' | 'rate_limited'
 *  | 'invalid_phone' | 'delivery_failed') — see app.ts's call sites. */
export function incrementOtpRequest(result: string): void {
  otpRequestsTotal.inc({ result });
}

/** e.g. 'success' | 'wrong_code' | 'expired' | 'too_many_attempts' |
 *  'no_code' | 'invalid_phone' | 'invalid_code' — see app.ts's call sites. */
export function incrementOtpVerification(result: string): void {
  otpVerificationsTotal.inc({ result });
}

// --- Exposition ----------------------------------------------------------

export interface RenderMetricsOptions {
  /** Job-queue counts by status, sampled at scrape time — pull-based
   *  (no interval is spawned to keep this "fresh"; the /metrics handler
   *  in app.ts calls apps/server/src/database.ts#countJobsByStatus()
   *  fresh on every request). Omit/null if that DB read failed — the
   *  jobs_total block is left out entirely rather than lying with
   *  zeros. */
  jobs?: Record<JobStatus, number> | null;
}

function helpAndType(name: string, text: string, type: 'counter' | 'gauge' | 'summary'): string[] {
  return [`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`];
}

const JOB_STATUSES: readonly JobStatus[] = ['pending', 'running', 'done', 'failed'];

/** Renders the full Prometheus text-exposition payload. Synchronous and
 *  side-effect-free except for reading `process.uptime()`/
 *  `process.memoryUsage()` (Node's own snapshot, no I/O) — the async
 *  jobs DB read happens in the caller (app.ts's GET /metrics) and is
 *  passed in already-resolved. */
export function renderMetrics(opts: RenderMetricsOptions = {}): string {
  const lines: string[] = [];

  lines.push(...helpAndType('http_requests_total', 'Total HTTP requests by method, route template, and status class.', 'counter'));
  lines.push(...httpRequestsTotal.lines('http_requests_total'));

  lines.push(...helpAndType('http_request_duration_ms', 'HTTP request duration in milliseconds (count/sum/max — no percentiles), by method/route/status class.', 'summary'));
  lines.push(...httpRequestDurationMs.lines('http_request_duration_ms'));

  lines.push(...helpAndType('http_server_errors_total', 'Requests that reached the global error-handling backstop (an uncaught exception/rejection), by route template.', 'counter'));
  lines.push(...httpServerErrorsTotal.lines('http_server_errors_total'));

  lines.push(...helpAndType('danger_escalations_total', 'Danger-sign escalations recorded (critical/high urgency only).', 'counter'));
  lines.push(...dangerEscalationsTotal.lines('danger_escalations_total'));

  lines.push(...helpAndType('llm_calls_total', 'Total calls into the single LLM chokepoint (packages/adapters/src/llm.ts#chat).', 'counter'));
  lines.push(...llmCallsTotal.lines('llm_calls_total'));

  lines.push(...helpAndType('llm_failures_total', 'LLM chokepoint calls that threw/rejected.', 'counter'));
  lines.push(...llmFailuresTotal.lines('llm_failures_total'));

  lines.push(...helpAndType('otp_requests_total', 'POST /auth/otp/request outcomes, by result.', 'counter'));
  lines.push(...otpRequestsTotal.lines('otp_requests_total'));

  lines.push(...helpAndType('otp_verifications_total', 'POST /auth/otp/verify outcomes, by result.', 'counter'));
  lines.push(...otpVerificationsTotal.lines('otp_verifications_total'));

  if (opts.jobs) {
    lines.push(...helpAndType('jobs_total', 'Current durable job-queue row counts by status (sampled at scrape time).', 'gauge'));
    for (const status of JOB_STATUSES) {
      lines.push(`jobs_total{status="${status}"} ${opts.jobs[status] ?? 0}`);
    }
  }

  lines.push(...helpAndType('process_uptime_seconds', 'Process uptime in seconds.', 'gauge'));
  lines.push(`process_uptime_seconds ${process.uptime().toFixed(3)}`);

  const mem = process.memoryUsage();
  lines.push(...helpAndType('nodejs_memory_rss_bytes', 'Resident set size, in bytes.', 'gauge'));
  lines.push(`nodejs_memory_rss_bytes ${mem.rss}`);
  lines.push(...helpAndType('nodejs_memory_heap_used_bytes', 'V8 heap used, in bytes.', 'gauge'));
  lines.push(`nodejs_memory_heap_used_bytes ${mem.heapUsed}`);
  lines.push(...helpAndType('nodejs_memory_heap_total_bytes', 'V8 heap total, in bytes.', 'gauge'));
  lines.push(`nodejs_memory_heap_total_bytes ${mem.heapTotal}`);
  lines.push(...helpAndType('nodejs_memory_external_bytes', 'Memory used by C++ objects bound to JS, in bytes.', 'gauge'));
  lines.push(`nodejs_memory_external_bytes ${mem.external}`);

  return lines.join('\n') + '\n';
}

// --- Test seam -----------------------------------------------------------
// Mirrors the __reset*/__set* seams elsewhere in this codebase
// (packages/adapters/src/twilio.ts, llm.ts) — this registry is a
// process-wide singleton like every other one of those, so tests need a
// way to start from a clean slate instead of accumulating counts across
// the whole suite. Never called from production code.
export function __resetMetrics(): void {
  httpRequestsTotal.reset();
  httpRequestDurationMs.reset();
  httpServerErrorsTotal.reset();
  dangerEscalationsTotal.reset();
  llmCallsTotal.reset();
  llmFailuresTotal.reset();
  otpRequestsTotal.reset();
  otpVerificationsTotal.reset();
}
