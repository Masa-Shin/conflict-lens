import type { WeakHighlightRange } from '../diff/weak-highlight';

/**
 * Approximate the in-memory cost of a result so the byte-bounded LRU does
 * not have to walk objects. Each `WeakHighlightRange` is three numbers and
 * a boolean; 48 bytes is a generous upper bound on V8.
 */
export function sizeOfRanges(ranges: WeakHighlightRange[]): number {
  return ranges.length * 48 + 16;
}

/**
 * Stable cache key for a `(file, inputs, documentVersion)` combination.
 * The GitRunner is excluded because it is a single shared instance for
 * the entire process.
 *
 * `documentVersion` (vscode.TextDocument.version) identifies the exact
 * right-side buffer content the result was computed against. A new
 * keystroke increments the version and produces a different key, so the
 * cache never serves stale ranges. HEAD SHA is not included because the
 * right side is the buffer, not HEAD — a HEAD movement that doesn't
 * touch the buffer should still be a cache hit.
 */
export function cacheKeyFor(
  relativeFilePath: string,
  inputs: {
    readonly repoRootPath: string;
    readonly baseBranch: string;
    readonly mergeBaseSha: string;
    readonly largeFileHunkThreshold: number;
  },
  documentVersion: number,
): string {
  return `${inputs.baseBranch} ${inputs.mergeBaseSha} t${inputs.largeFileHunkThreshold} v${documentVersion} ${inputs.repoRootPath} ${relativeFilePath}`;
}

/**
 * Escape Markdown metacharacters in dynamic strings before embedding them
 * in a `MarkdownString` hover. The hover is trusted (its `isTrusted`
 * allow-lists Conflict Lens's own command links so they fire — see
 * `buildHoverMessage`), so escaping matters here: it stops a branch name
 * from injecting link/command syntax of its own and keeps incidental
 * characters (e.g. a `*` in the name) from being rendered as formatting.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]()<>#~|!{}+-]/g, (c) => `\\${c}`);
}
