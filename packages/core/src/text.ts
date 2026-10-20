// Small pure text helpers. No I/O.

/**
 * A reply cut off by the model's token cap (finish_reason 'length') ends
 * mid-sentence — the 2026-10 simulation had mothers asking what the rest
 * of a warning said. Cut back to the last complete sentence (or line), as
 * long as that keeps most of the text; otherwise close it with an ellipsis.
 */
export function trimToLastSentence(text: string): string {
  const trimmed = text.trimEnd();
  if (/[.!?…)"'”💚🌼🤰]$/u.test(trimmed)) return trimmed;
  const ends = [...trimmed.matchAll(/[.!?…](?=\s|$)|\n/g)].map((m) => (m.index ?? 0) + 1);
  const cut = ends.length ? ends[ends.length - 1] : -1;
  if (cut > trimmed.length * 0.5) return trimmed.slice(0, cut).trimEnd();
  return `${trimmed}…`;
}
