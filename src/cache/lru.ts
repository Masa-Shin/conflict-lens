/**
 * Byte-bounded LRU cache.
 *
 * Spec §5.4 mandates byte-based limits (not entry-count) so that a single
 * 50k-line file cannot blow the extension host's memory budget. Per-entry
 * cap rejects values larger than `maxEntryBytes` outright so a giant
 * outlier cannot evict everything useful.
 *
 * `Map` in modern JS preserves insertion order, so LRU is implemented by
 * deleting and re-inserting on access. No external dependency required.
 */
export class ByteLruCache<K, V> {
  private readonly map = new Map<K, { value: V; size: number }>();
  private currentBytes = 0;

  constructor(
    public readonly maxBytes: number,
    public readonly maxEntryBytes: number,
    private readonly sizeOf: (value: V) => number,
  ) {
    if (maxBytes <= 0 || maxEntryBytes <= 0) {
      throw new Error('ByteLruCache: maxBytes and maxEntryBytes must be > 0');
    }
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Move to most-recently-used by re-inserting.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    const size = this.sizeOf(value);
    if (!Number.isFinite(size) || size < 0) return;
    if (size > this.maxEntryBytes) {
      // Even after evicting everything we couldn't hold this entry. Drop it
      // *and* make sure any stale prior entry under the same key is gone.
      const existing = this.map.get(key);
      if (existing) {
        this.currentBytes -= existing.size;
        this.map.delete(key);
      }
      return;
    }
    const existing = this.map.get(key);
    if (existing) {
      this.currentBytes -= existing.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.currentBytes += size;
    this.evict();
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.currentBytes -= entry.size;
    this.map.delete(key);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.currentBytes = 0;
  }

  /** Diagnostic helpers (used by debug logging per spec §5.4 observability). */
  stats(): { entries: number; bytes: number } {
    return { entries: this.map.size, bytes: this.currentBytes };
  }

  private evict(): void {
    while (this.currentBytes > this.maxBytes) {
      const oldestKey = this.map.keys().next().value as K | undefined;
      if (oldestKey === undefined) return;
      const entry = this.map.get(oldestKey)!;
      this.currentBytes -= entry.size;
      this.map.delete(oldestKey);
    }
  }
}
