// P2-F carried fix: apps/web/public/sw.js's API_GET_PATHS list must bypass
// SW caching for GET /insights (P2-E's Insights endpoint), same as the
// pre-existing /me, /history, /journal/today, /journal/entries entries —
// otherwise a lie-fi same-origin GET to /insights can fall through to the
// SW's generic cache-first/network-fallback branch, which hands back the
// cached '/offline' HTML page as a fake 200 in place of the JSON response
// api.ts expects (see the comment block above API_GET_PATHS in sw.js).
//
// sw.js is a plain, non-module service-worker script (registers `self`
// listeners at load time) — it can't be `import`ed directly under Vitest's
// default node environment (no `self` global). Instead this reads the file
// as text and parses just the RegExp *literals* inside the
// `const API_GET_PATHS = [...]` array (no eval/new Function — each literal
// is extracted with a regex and rebuilt via `new RegExp(pattern, flags)`)
// to get real RegExp objects to test against sample paths — the same
// "parity by construction, not by hand-copied assertions" spirit as
// tests/offlineDangerSignsParity.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SW_PATH = path.join(__dirname, '..', 'apps', 'web', 'public', 'sw.js');

function extractApiGetPaths(): RegExp[] {
  const source = readFileSync(SW_PATH, 'utf8');
  const arrayMatch = source.match(/const API_GET_PATHS = \[([^\]]*)\];/);
  if (!arrayMatch) throw new Error('API_GET_PATHS not found in apps/web/public/sw.js');
  const body = arrayMatch[1]!;
  // Matches a JS regex literal: /pattern/flags, where pattern may contain
  // escaped characters (\/, \d, etc.) or any non-slash/backslash char.
  const literalPattern = /\/((?:\\.|[^/\\])+)\/([a-z]*)/g;
  const patterns: RegExp[] = [];
  let m: RegExpExecArray | null;
  while ((m = literalPattern.exec(body)) !== null) {
    patterns.push(new RegExp(m[1]!, m[2]));
  }
  if (patterns.length === 0) throw new Error('No RegExp literals parsed out of API_GET_PATHS');
  return patterns;
}

describe('sw.js API_GET_PATHS (P2-F: /insights bypass)', () => {
  const paths = extractApiGetPaths();

  it('bypasses SW caching for GET /insights', () => {
    expect(paths.some((re) => re.test('/insights'))).toBe(true);
  });

  it('does not bypass unrelated paths that merely start with "/insights"-like text', () => {
    // Exact-match anchored, same style as /^\/history$/ and
    // /^\/journal\/today$/ — a sub-path must not accidentally match.
    expect(paths.some((re) => re.test('/insights/export'))).toBe(false);
    expect(paths.some((re) => re.test('/insightsomething'))).toBe(false);
  });

  it('still bypasses the pre-existing API GET paths (no regression)', () => {
    const stillCovered = [
      '/me',
      '/me/medical-history',
      '/history',
      '/journal/entries',
      '/journal/entries?days=14',
      '/journal/today',
    ];
    stillCovered.forEach((p) => {
      const url = p.split('?')[0];
      expect(paths.some((re) => re.test(url))).toBe(true);
    });
  });

  it('does not bypass ordinary page/shell routes', () => {
    ['/', '/home', '/journal', '/chat', '/profile', '/login', '/offline'].forEach((p) => {
      expect(paths.some((re) => re.test(p))).toBe(false);
    });
  });
});
