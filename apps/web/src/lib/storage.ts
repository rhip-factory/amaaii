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

// --- Post-delete one-shot notice (P3-D) -----------------------------------
// sessionStorage (not localStorage — this should not survive a fresh tab
// or linger indefinitely) carries a single flag from the Profile page's
// delete flow across the redirect to /login, so the login screen can
// show "your account and data have been deleted" exactly once. Reading
// it via consumeDeletedFlag() clears it immediately, so a refresh of
// /login afterwards doesn't keep re-showing the notice.
const DELETED_FLAG_KEY = "amaaii.web.deletedNotice";

export function setDeletedFlag(): void {
  try {
    window.sessionStorage.setItem(DELETED_FLAG_KEY, "1");
  } catch {
    /* best-effort — a missed notice is not worth failing the delete flow over */
  }
}

export function consumeDeletedFlag(): boolean {
  try {
    const present = window.sessionStorage.getItem(DELETED_FLAG_KEY) === "1";
    if (present) window.sessionStorage.removeItem(DELETED_FLAG_KEY);
    return present;
  } catch {
    return false;
  }
}
