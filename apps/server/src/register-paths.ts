// DIST-BOOT STRATEGY (P1-E — see CLAUDE.md / the P1-E final report for
// the full writeup).
//
// `tsc` (module: commonjs) emits `require("@amaaii/core")` and
// `require("@amaaii/adapters")` literally in compiled output — it does
// not rewrite tsconfig.json's `paths` aliases to relative paths the way
// a bundler (or `tsc-alias`) would. Two entry points need to boot:
//   - `tsx apps/server/src/index.ts` (dev, `pnpm start`/`pnpm dev`,
//     vitest): tsx has built-in tsconfig-paths resolution, so bare
//     `@amaaii/*` specifiers already resolve correctly there and the
//     fallback below never triggers.
//   - `node dist/apps/server/src/index.js` (the compiled artifact
//     `pnpm build` produces): plain Node has no idea what "@amaaii/core"
//     means and throws MODULE_NOT_FOUND.
//
// Rather than rewriting ~20 files' imports to relative paths (a much
// larger, riskier diff for what's supposed to be a mechanical port) or
// pulling in a bundler/new dependency (tsc-alias, module-alias) for
// exactly two package names, this registers a narrow fallback: only for
// these two known specifiers, and only once Node's own resolution has
// already failed, resolve to the compiled sibling package instead. The
// source tree and the compiled dist tree mirror the same
// apps/server/src <-> packages/* relative nesting (dist just adds one
// `dist/` segment in front of BOTH sides equally), so a fixed relative
// hop count from THIS file's own location resolves correctly whichever
// tree it's actually running from.
//
// Must be the first thing index.ts imports — before anything else in
// the require graph reaches for `@amaaii/core` / `@amaaii/adapters`.
import Module from 'node:module';
import path from 'node:path';

// `Module._resolveFilename` is a long-standing de facto API (this is
// exactly the mechanism packages like `module-alias` patch), but it
// isn't part of @types/node's public surface — hence the `any`s below.
// This file's whole job is monkey-patching Node's own module resolver,
// which is inherently untyped territory.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ModuleAny = Module as any;

const ALIASES: Record<string, string> = {
  '@amaaii/core': path.join(__dirname, '..', '..', '..', 'packages', 'core', 'src', 'index'),
  '@amaaii/adapters': path.join(__dirname, '..', '..', '..', 'packages', 'adapters', 'src', 'index'),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalResolveFilename: (...args: any[]) => string = ModuleAny._resolveFilename;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
ModuleAny._resolveFilename = function patchedResolveFilename(request: string, ...rest: any[]): string {
  try {
    return originalResolveFilename.call(Module, request, ...rest);
  } catch (err) {
    const alias = ALIASES[request];
    if (alias) {
      return originalResolveFilename.call(Module, alias, ...rest);
    }
    throw err;
  }
};
