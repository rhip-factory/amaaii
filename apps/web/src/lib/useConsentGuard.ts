"use client";

// P3-D: client-side consent gate for the authed (app) route group.
// Server-side enforcement already exists (POST /chat returns
// {consentRequired:true} for a non-consented user — see CLAUDE.md's
// "/chat and /insights are both a page route and an API path" note and
// messageHandler.ts's consent-gate block) — this hook is the UX layer on
// top of that: it catches the case up front, on ANY authed page, rather
// than making the mother discover it only when she happens to open Chat.
//
// Runs once per mount (via the `checked` ref) rather than on every
// render/navigation — a version bump mid-session is rare enough that
// "catches it on the next full app load" is an acceptable trade for
// never hammering GET /me/consent on every route change. AppShell (the
// one place mounted for every (app) page) is this hook's only call site.
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { fetchConsent } from "./api";
import { getToken } from "./storage";

export function useConsentGuard(ready: boolean): void {
  const router = useRouter();
  const checked = useRef(false);

  useEffect(() => {
    if (!ready || checked.current) return;
    if (!getToken()) return; // useSession() will already be redirecting to /login
    checked.current = true;

    (async () => {
      try {
        const consent = await fetchConsent();
        if (consent.needsConsent) {
          router.replace("/consent");
        }
      } catch {
        // Offline, or the API is unreachable — don't block the whole app
        // on a check that can't complete; POST /chat still enforces
        // consent server-side regardless of whether this client-side
        // gate got to run. Deterministic features (journaling, danger
        // detection) never depended on consent status anyway.
      }
    })();
  }, [ready, router]);
}
