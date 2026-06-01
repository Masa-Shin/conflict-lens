/** Normalize CRLF / lone CR to LF so memory diff sees a single newline style. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Strip a leading UTF-8 BOM (`U+FEFF`) if present. `git show` may emit the
 * BOM for files that have one, while VSCode's TextDocument strips it; we
 * normalize both sides so the first line is not misclassified.
 */
export function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Canonicalize text for diff input: strip BOM, then normalize line endings.
 * Returns the same string instance when already canonical (no allocation).
 */
export function normalizeForDiff(text: string): string {
  const stripped = stripUtf8Bom(text);
  return normalizeLineEndings(stripped);
}

/**
 * Split a process stdout into individual lines, accepting LF, CR, and CRLF
 * terminators. **Use this instead of `text.split('\n')`** when parsing
 * git output on platforms that may emit CRLF — Windows git outputs CRLF
 * by default and leaves a stray `\r` on every entry if split is naive.
 * The trailing empty element after the final newline is dropped.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const trimmed = text.endsWith('\n') || text.endsWith('\r') ? text.replace(/[\r\n]+$/, '') : text;
  return trimmed.split(/\r\n|\r|\n/);
}
