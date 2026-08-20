// Provider-portal API client (P5-B) — mirrors lib/api.ts's fetch/auth
// pattern (timeout, JSON parsing, error shape) but talks the PROVIDER
// bearer token from providerStorage.ts, never the mother token from
// storage.ts, and redirects an expired/invalid session to
// /provider/login, never /login. See providerStorage.ts's header for
// why the two token stores are kept fully separate.
//
// Paths are relative (via the shared API_BASE from lib/api.ts) so this
// works the same way in `next dev` (proxied by next.config.ts's
// rewrites) and in a deployed static export (NEXT_PUBLIC_API_ORIGIN
// prefix). None of these /provider/* paths collide with a page route
// (the pages are /provider, /provider/login, /provider/patient — none
// of which match an API path below), so unlike /chat and /insights this
// needed no X-Amaaii-Api header workaround.

import { API_BASE } from "./api";
import { clearProviderSession, getProviderToken } from "./providerStorage";
import type {
  ProviderDailyPoint,
  ProviderEnrollResponse,
  ProviderLoginResponse,
  ProviderPatientDetail,
  ProviderPatientsResponse,
  ProviderSummary,
} from "./providerTypes";

const REQUEST_TIMEOUT_MS = 8000;

export class ProviderApiError extends Error {
  status: number;
  /** The server's machine-readable `error` code, e.g. `no_provider_consent` —
   *  callers branch on this for designed-outcome states, not just the
   *  human-readable message. */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ProviderApiError";
    this.status = status;
    this.code = code;
  }
}

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) {
    throw new ProviderApiError(data.message || data.error || `Request failed (${res.status})`, res.status, data.error);
  }
  return data;
}

async function providerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getProviderToken();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    clearProviderSession();
    if (typeof window !== "undefined") {
      window.location.href = "/provider/login";
    }
    throw new ProviderApiError("unauthorized", 401);
  }
  return res;
}

// No provider token exists yet at login time, so this bypasses
// providerFetch entirely (a 401 here is just "wrong password", not an
// expired-session redirect).
export async function providerLogin(email: string, password: string): Promise<ProviderLoginResponse> {
  const res = await fetch(`${API_BASE}/provider/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return parseJsonOrThrow<ProviderLoginResponse>(res);
}

export async function fetchProviderSummary(): Promise<ProviderSummary> {
  const res = await providerFetch("/provider/summary");
  return parseJsonOrThrow<ProviderSummary>(res);
}

export async function fetchProviderPatients(): Promise<ProviderPatientsResponse> {
  const res = await providerFetch("/provider/patients");
  return parseJsonOrThrow<ProviderPatientsResponse>(res);
}

// A 403 { error: 'no_provider_consent' } is a DESIGNED outcome, not a
// failure — see the "awaiting consent" panel this feeds on the patient
// detail page. Callers branch on ProviderApiError#code, not just #status,
// so a future distinct 403 reason doesn't get misread as this one.
export async function fetchProviderPatientDetail(phone: string): Promise<ProviderPatientDetail> {
  const res = await providerFetch(`/provider/patients/detail?phone=${encodeURIComponent(phone)}`);
  const raw = await parseJsonOrThrow<ProviderPatientDetail & { dailySeries?: unknown }>(res);
  return { ...raw, dailySeries: normalizeDailySeries(raw.dailySeries) };
}

// See providerTypes.ts's ProviderDailyPoint doc comment: the spec's
// `dailySeries` field name is ambiguous between one merged per-day array
// and computeDailySeries' actual two-calls-two-arrays shape. This
// normalizes whichever the server actually sends into the merged shape
// the detail page renders, so a resolved ambiguity is a one-line fix
// here rather than a page-level rewrite.
function normalizeDailySeries(raw: unknown): ProviderDailyPoint[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .map((p) => ({
        date: String(p.date ?? ""),
        mood: typeof p.mood === "number" ? p.mood : null,
        sleepHours: typeof p.sleepHours === "number" ? p.sleepHours : null,
      }))
      .filter((p) => p.date)
      // LineChart requires date-ascending input — don't trust the wire
      // order (ISO YYYY-MM-DD sorts correctly as a plain string).
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  if (raw && typeof raw === "object") {
    const obj = raw as { moodSeries?: unknown; sleepSeries?: unknown };
    if (Array.isArray(obj.moodSeries) || Array.isArray(obj.sleepSeries)) {
      const moodByDate = new Map<string, number>();
      const sleepByDate = new Map<string, number>();
      for (const p of Array.isArray(obj.moodSeries) ? obj.moodSeries : []) {
        if (p && typeof p === "object" && "date" in p && "value" in p) {
          moodByDate.set(String((p as { date: unknown }).date), Number((p as { value: unknown }).value));
        }
      }
      for (const p of Array.isArray(obj.sleepSeries) ? obj.sleepSeries : []) {
        if (p && typeof p === "object" && "date" in p && "value" in p) {
          sleepByDate.set(String((p as { date: unknown }).date), Number((p as { value: unknown }).value));
        }
      }
      const dates = Array.from(new Set([...moodByDate.keys(), ...sleepByDate.keys()])).sort();
      return dates.map((date) => ({
        date,
        mood: moodByDate.has(date) ? (moodByDate.get(date) as number) : null,
        sleepHours: sleepByDate.has(date) ? (sleepByDate.get(date) as number) : null,
      }));
    }
  }
  return [];
}

export async function enrollPatient(phone: string, name?: string): Promise<ProviderEnrollResponse> {
  const res = await providerFetch("/provider/enroll", {
    method: "POST",
    body: JSON.stringify(name ? { phone, name } : { phone }),
  });
  return parseJsonOrThrow<ProviderEnrollResponse>(res);
}
