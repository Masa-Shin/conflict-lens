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
 * Stable cache key for a `(file, inputs)` combination. The GitRunner is
 * excluded because it is a single shared instance for the entire process.
 */
export function cacheKeyFor(
  relativeFilePath: string,
  inputs: {
    readonly repoRootPath: string;
    readonly baseBranch: string;
    readonly mergeBaseSha: string;
    readonly headSha: string;
  },
): string {
  return `${inputs.baseBranch} ${inputs.mergeBaseSha} ${inputs.headSha} ${inputs.repoRootPath} ${relativeFilePath}`;
}

/**
 * Escape Markdown metacharacters in dynamic strings before embedding them
 * in a `MarkdownString` hover. The hover itself is constructed with
 * `isTrusted = false` so command links cannot fire, but escaping avoids
 * accidental formatting (e.g. branch names containing `*`).
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]()<>#~|!{}+-]/g, (c) => `\\${c}`);
}
