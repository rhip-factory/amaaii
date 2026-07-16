// localStorage session helpers. Mirrors public/app.js's TOKEN_KEY/USER_KEY
// pair exactly (same keys are NOT reused — this is a separate app/origin
// in dev — but the shape matches so the two clients stay easy to compare).

import type { SessionUser } from "./types";

const TOKEN_KEY = "amaaii.web.token";
const USER_KEY = "amaaii.web.user";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: SessionUser): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}
