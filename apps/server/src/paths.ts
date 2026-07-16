// Locates the repo root and the `public/` PWA asset directory relative
// to it. This is new in P1-E (server.js used to sit at the repo root and
// just did `path.join(__dirname, 'public')`; apps/server/src/app.ts sits
// several directories deeper).
//
// DIST-BOOT STRATEGY (documented per P1-E's verify requirements): a
// fixed number of `path.join(__dirname, '..', ...)` hops can't serve
// both entry points, because `pnpm build`'s outDir inserts an extra
// `dist/` segment that changes the depth below the repo root:
//   tsx dev:   <root>/apps/server/src/paths.ts        (3 hops to root)
//   compiled:  <root>/dist/apps/server/src/paths.js   (4 hops to root)
// A path resolved for one entry point silently resolves to the wrong
// directory (or nothing) for the other. Rather than special-casing dev
// vs. dist, we walk up from `__dirname` until we find the repo's
// package.json — that's robust to any nesting depth and works
// identically whether this file is loaded as TypeScript via tsx or as
// compiled JS via `node dist/...`.
import fs from 'node:fs';
import path from 'node:path';

export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir; // reached filesystem root; give up gracefully
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(__dirname);
export const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
