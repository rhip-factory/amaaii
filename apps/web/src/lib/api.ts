// Authed fetch helper + typed API calls. Endpoints and payload shapes are
// read directly from apps/server/src/app.ts (see also public/app.js,
// which drives the same server) — nothing here is invented.
//
// Paths are relative ("/chat", not an absolute origin) so the same code
// works in two environments:
//  - `next dev`: next.config.ts rewrites these to AMAAII_API_ORIGIN.
//  - a deployed static export: NEXT_PUBLIC_API_ORIGIN is prefixed below
//    (rewrites don't exist once there's no server — see next.config.ts).

import { clearSession, getToken } from "./storage";
import { cachedGet, type CachedResult } from "./offlineCache";
import type {
  ActivityResponse,
  ApiErrorBody,
  ChatResponse,
  ConsentGrants,
  ConsentPurpose,
  ConsentResponse,
  DeleteAccountResponse,
  HistoryResponse,
  InsightsResponse,
  InsightsWindow,
  JournalEntryInput,
  JournalEntrySubmitResponse,
  JournalHistoryResponse,
  JournalTodayResponse,
  MeResponse,
  MeUser,
  ProfileUpdate,
} from "./types";

export const API_BASE =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_ORIGIN
    ? process.env.NEXT_PUBLIC_API_ORIGIN
    : "";

// Short enough that a hung request on a bad connection resolves to a
// network-failure classification quickly (see outbox.ts's
// isClientRejection / JournalCheckIn's submit catch, and offlineCache.ts's
// stale-while-revalidate fallback) rather than spinning indefinitely —
// part of the P2-D "never a spinner-forever" goal.
const REQUEST_TIMEOUT_MS = 8000;

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class UnauthorizedError extends ApiError {
  constructor() {
    super("unauthorized", 401);
    this.name = "UnauthorizedError";
  }
}

async function authedFetch(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  // Marks this as an API call rather than a page navigation — see the
  // `/chat` beforeFiles rewrite in next.config.ts, which needs to tell
  // the two apart since they share the same path.
  headers.set("X-Amaaii-Api", "1");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    clearSession();
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new UnauthorizedError();
  }
  return res;
}

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!res.ok) {
    throw new ApiError(data.message || data.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

// --- Offline-first reads (P2-D) ---------------------------------------------
// fetchMe / fetchTodayJournal / fetchJournalHistory are stale-while-
// revalidate: offline (or on any fetch failure), they resolve with the
// last-known response from IndexedDB instead of throwing, marked
// `stale: true`, so Home/Journal always have something honest to render
// — see offlineCache.ts for the full read-path rationale.

export async function fetchMe(): Promise<CachedResult<MeResponse>> {
  return cachedGet("me", async () => {
    const res = await authedFetch("/me");
    return parseJsonOrThrow<MeResponse>(res);
  });
}

export async function updateMe(updates: ProfileUpdate): Promise<{ user: MeUser }> {
  const res = await authedFetch("/me", { method: "PUT", body: JSON.stringify(updates) });
  return parseJsonOrThrow<{ user: MeUser }>(res);
}

export async function fetchHistory(): Promise<HistoryResponse> {
  const res = await authedFetch("/history");
  return parseJsonOrThrow<HistoryResponse>(res);
}

// --- Structured journal check-in form (P2-C) --------------------------------

export async function submitJournalEntry(input: JournalEntryInput): Promise<JournalEntrySubmitResponse> {
  const res = await authedFetch("/journal/entries", { method: "POST", body: JSON.stringify(input) });
  return parseJsonOrThrow<JournalEntrySubmitResponse>(res);
}

export async function fetchTodayJournal(): Promise<CachedResult<JournalTodayResponse>> {
  return cachedGet("journal:today", async () => {
    const res = await authedFetch("/journal/today");
    return parseJsonOrThrow<JournalTodayResponse>(res);
  });
}

export async function fetchJournalHistory(days = 14): Promise<CachedResult<JournalHistoryResponse>> {
  return cachedGet(`journal:history:${days}`, async () => {
    const res = await authedFetch(`/journal/entries?days=${days}`);
    return parseJsonOrThrow<JournalHistoryResponse>(res);
  });
}

// --- Insights (P2-E) ---------------------------------------------------------
// Same stale-while-revalidate path as the other offline-first GETs, keyed
// per window so a cached 14-day view is never silently presented as the
// 30-day one. The Home trends card shares the `insights:14` key with the
// Insights tab's default view, so either screen warms the cache for both.

export async function fetchInsights(days: InsightsWindow = 14): Promise<CachedResult<InsightsResponse>> {
  return cachedGet(`insights:${days}`, async () => {
    const res = await authedFetch(`/insights?days=${days}`);
    return parseJsonOrThrow<InsightsResponse>(res);
  });
}

// --- Consent (P3-D) -----------------------------------------------------
// Thin wrappers over GET/POST /me/consent + POST /me/consent/revoke.
// Not offline-cached (unlike fetchMe/fetchTodayJournal/etc. above) —
// consent is a gate, not a read-and-render screen, so a stale cached
// "you're fine" would be actively wrong to show while offline.

export async function fetchConsent(): Promise<ConsentResponse> {
  const res = await authedFetch("/me/consent");
  return parseJsonOrThrow<ConsentResponse>(res);
}

export async function submitConsent(grants: ConsentGrants): Promise<ConsentResponse> {
  const res = await authedFetch("/me/consent", { method: "POST", body: JSON.stringify({ grants }) });
  return parseJsonOrThrow<ConsentResponse>(res);
}

export async function revokeConsentPurpose(purpose: ConsentPurpose): Promise<ConsentResponse> {
  const res = await authedFetch("/me/consent/revoke", { method: "POST", body: JSON.stringify({ purpose }) });
  return parseJsonOrThrow<ConsentResponse>(res);
}

// --- Activity log (P3-D) --------------------------------------------------

export async function fetchActivity(): Promise<ActivityResponse> {
  const res = await authedFetch("/me/activity");
  return parseJsonOrThrow<ActivityResponse>(res);
}

// --- Data-subject rights: export + delete (P3-D) --------------------------
// GET /me/export is an authed endpoint, so a plain <a href="/me/export">
// can't carry the bearer token — fetch the JSON as a blob and trigger the
// download via a throwaway object URL instead (the standard workaround
// for authed downloads in a browser).
export async function downloadMyData(): Promise<void> {
  const res = await authedFetch("/me/export");
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as ApiErrorBody;
    throw new ApiError(data.message || data.error || `Request failed (${res.status})`, res.status);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match?.[1] || `amaaii-my-data-${new Date().toISOString().slice(0, 10)}.json`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// DELETE /me/account — irreversible erasure. Body is an explicit empty
// object: apps/server/src/app.ts 400s if the body carries a `phone` key
// at all (the caller's own phone always comes from the bearer token,
// never the body — see its handler comment), so this must never be
// changed to pass one.
export async function deleteAccount(): Promise<DeleteAccountResponse> {
  const res = await authedFetch("/me/account", { method: "DELETE", body: JSON.stringify({}) });
  return parseJsonOrThrow<DeleteAccountResponse>(res);
}

// /chat's error body (see apps/server/src/app.ts) carries a user-facing
// `response` string even on a 500 ("I apologize, I'm having trouble
// processing that…") — public/app.js renders that as a normal bot bubble
// rather than a hard error, so this mirrors that instead of throwing.
export async function sendChatMessage(message: string): Promise<ChatResponse> {
  const res = await authedFetch("/chat", { method: "POST", body: JSON.stringify({ message }) });
  const data = (await res.json().catch(() => ({}))) as Partial<ChatResponse> & ApiErrorBody;
  if (!res.ok) {
    if (typeof data.response === "string") {
      return { response: data.response, urgencyLevel: "low" };
    }
    throw new ApiError(data.message || data.error || `Request failed (${res.status})`, res.status);
  }
  return data as ChatResponse;
}
