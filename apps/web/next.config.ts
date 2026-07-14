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
      ],
      // These don't collide with any page route, so plain (afterFiles)
      // rewrites are enough.
      afterFiles: [
        { source: "/auth/:path*", destination: `${API_ORIGIN}/auth/:path*` },
        { source: "/me", destination: `${API_ORIGIN}/me` },
        { source: "/me/:path*", destination: `${API_ORIGIN}/me/:path*` },
        { source: "/history", destination: `${API_ORIGIN}/history` },
      ],
      fallback: [],
    };
  },
};

export default nextConfig;
