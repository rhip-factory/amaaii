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
import type {
  ApiErrorBody,
  ChatResponse,
  HistoryResponse,
  MeResponse,
  MeUser,
  ProfileUpdate,
} from "./types";

const API_BASE =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_ORIGIN
    ? process.env.NEXT_PUBLIC_API_ORIGIN
    : "";

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

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  // Marks this as an API call rather than a page navigation — see the
  // `/chat` beforeFiles rewrite in next.config.ts, which needs to tell
  // the two apart since they share the same path.
  headers.set("X-Amaaii-Api", "1");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

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

export async function fetchMe(): Promise<MeResponse> {
  const res = await authedFetch("/me");
  return parseJsonOrThrow<MeResponse>(res);
}

export async function updateMe(updates: ProfileUpdate): Promise<{ user: MeUser }> {
  const res = await authedFetch("/me", { method: "PUT", body: JSON.stringify(updates) });
  return parseJsonOrThrow<{ user: MeUser }>(res);
}

export async function fetchHistory(): Promise<HistoryResponse> {
  const res = await authedFetch("/history");
  return parseJsonOrThrow<HistoryResponse>(res);
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
