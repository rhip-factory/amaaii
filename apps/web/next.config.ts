import type { NextConfig } from "next";

// Dev-only API proxy. `next dev` runs a real server, so rewrites work;
// `next build` (output: 'export') produces static HTML with no server to
// apply them — the exported app talks to the API directly via
// NEXT_PUBLIC_API_ORIGIN instead (see src/lib/api.ts). Keeping rewrites()
// here is harmless for the static build (Next ignores it at export time)
// and is what makes `next dev` usable against a real Express server
// without hard-coding an origin into every fetch call.
const API_ORIGIN = process.env.AMAAII_API_ORIGIN || "http://localhost:3000";

const nextConfig: NextConfig = {
  output: "export",
  // Overridable in case a build needs to write to a named alternate
  // directory. NOTE (verified empirically on Next 15.5.20): with
  // `output: "export"`, `next build`'s internal export renderer still
  // writes a full production build (BUILD_ID, server/, static/, etc.)
  // into the literal `.next/` directory regardless of this setting — it
  // is NOT sufficient to protect a `.next` a live `next dev` is using.
  // Never run `next build` in a checkout where `next dev` is also
  // running against the same `apps/web/.next` — build in an isolated
  // git worktree (or a full copy of the repo) instead.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return {
      // `/chat` is BOTH the Chat tab's page route and the API's chat
      // endpoint — a real collision. Default (afterFiles) rewrites run
      // after Next's own filesystem router, so a plain POST to "/chat"
      // was silently swallowed by the page route and returned page HTML
      // instead of reaching Express. beforeFiles rewrites run first, but
      // apply regardless of method, so gate it on a header (`x-amaaii-api`,
      // set by src/lib/api.ts on every API call) rather than intercepting
      // ordinary GET navigations to the page too.
      beforeFiles: [
        {
          source: "/chat",
          has: [{ type: "header", key: "x-amaaii-api" }],
          destination: `${API_ORIGIN}/chat`,
        },
        // Same collision as /chat: "/insights" is BOTH the Insights tab's
        // page route and the API's GET /insights endpoint (P2-E) — gate on
        // the api-call header so ordinary navigations still reach the page.
        {
          source: "/insights",
          has: [{ type: "header", key: "x-amaaii-api" }],
          destination: `${API_ORIGIN}/insights`,
        },
        // P6: same collision — /provider/escalations and /provider/cohort
        // are now both page routes (app/provider/(dashboard)/escalations,
        // .../cohort) AND the GET API paths for the escalation feed and
        // cohort analytics. providerApi.ts's providerFetch sets the same
        // x-amaaii-api header on every provider call (see its comment),
        // so ordinary page navigations (no header) still fall through to
        // the page route below.
        {
          source: "/provider/escalations",
          has: [{ type: "header", key: "x-amaaii-api" }],
          destination: `${API_ORIGIN}/provider/escalations`,
        },
        {
          source: "/provider/cohort",
          has: [{ type: "header", key: "x-amaaii-api" }],
          destination: `${API_ORIGIN}/provider/cohort`,
        },
      ],
      // These don't collide with any page route, so plain (afterFiles)
      // rewrites are enough.
      afterFiles: [
        { source: "/auth/:path*", destination: `${API_ORIGIN}/auth/:path*` },
        { source: "/me", destination: `${API_ORIGIN}/me` },
        { source: "/me/:path*", destination: `${API_ORIGIN}/me/:path*` },
        { source: "/history", destination: `${API_ORIGIN}/history` },
        // /journal (no sub-path) is the Journal tab's page route — these
        // sub-paths don't collide with it, same reasoning as /history above.
        { source: "/journal/entries", destination: `${API_ORIGIN}/journal/entries` },
        { source: "/journal/today", destination: `${API_ORIGIN}/journal/today` },
        // P5-B provider portal. No collision with a page route to worry
        // about here — the pages are /provider, /provider/login, and
        // /provider/patient, none of which match any of these API
        // sub-paths — so unlike /chat and /insights above these don't
        // need the beforeFiles + header gating workaround.
        { source: "/provider/auth/:path*", destination: `${API_ORIGIN}/provider/auth/:path*` },
        { source: "/provider/summary", destination: `${API_ORIGIN}/provider/summary` },
        { source: "/provider/patients", destination: `${API_ORIGIN}/provider/patients` },
        { source: "/provider/patients/detail", destination: `${API_ORIGIN}/provider/patients/detail` },
        { source: "/provider/enroll", destination: `${API_ORIGIN}/provider/enroll` },
        // P6: no collision — no page route matches this exact sub-path
        // (the page is /provider/escalations, not /provider/escalations/ack).
        { source: "/provider/escalations/ack", destination: `${API_ORIGIN}/provider/escalations/ack` },
      ],
      fallback: [],
    };
  },
};

export default nextConfig;
