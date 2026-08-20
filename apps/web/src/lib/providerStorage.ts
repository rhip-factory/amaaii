// localStorage session helpers for the PROVIDER portal — deliberately a
// SEPARATE key pair from lib/storage.ts's mother session
// (amaaii.web.token / amaaii.web.user). A provider signing in on the
// same device/browser as a mother account must never be treated as her,
// and vice versa (spec: "Provider tokens and mother tokens are NOT
// interchangeable"). This is the client-side half of that guarantee;
// the server-side half is providerAuth.ts's `provider:`-prefixed `sub`
// (apps/server, outside this package's scope) rejecting cross-over
// tokens outright even if a client ever mixed them up.

import type { ProviderSessionUser } from "./providerTypes";

const PROVIDER_TOKEN_KEY = "amaaii.provider.token";
const PROVIDER_USER_KEY = "amaaii.provider.user";

export function getProviderToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(PROVIDER_TOKEN_KEY);
}

export function getStoredProvider(): ProviderSessionUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PROVIDER_USER_KEY);
    return raw ? (JSON.parse(raw) as ProviderSessionUser) : null;
  } catch {
    return null;
  }
}

export function setProviderSession(token: string, provider: ProviderSessionUser): void {
  window.localStorage.setItem(PROVIDER_TOKEN_KEY, token);
  window.localStorage.setItem(PROVIDER_USER_KEY, JSON.stringify(provider));
}

export function clearProviderSession(): void {
  window.localStorage.removeItem(PROVIDER_TOKEN_KEY);
  window.localStorage.removeItem(PROVIDER_USER_KEY);
}
