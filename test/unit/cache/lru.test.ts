import { describe, expect, it } from 'vitest';

import { ByteLruCache } from '../../../src/cache/lru';

function bytesOf(value: string): number {
  return value.length;
}

describe('ByteLruCache', () => {
  it('rejects non-positive size limits in the constructor', () => {
    expect(() => new ByteLruCache<string, string>(0, 10, bytesOf)).toThrow();
    expect(() => new ByteLruCache<string, string>(10, 0, bytesOf)).toThrow();
  });

  it('returns undefined for missing keys', () => {
    const cache = new ByteLruCache<string, string>(10, 5, bytesOf);
    expect(cache.get('nope')).toBeUndefined();
  });

  it('stores and retrieves a value', () => {
    const cache = new ByteLruCache<string, string>(10, 10, bytesOf);
    cache.set('a', 'hello');
    expect(cache.get('a')).toBe('hello');
    expect(cache.stats()).toEqual({ entries: 1, bytes: 5 });
  });

  it('evicts the least-recently-used entry when over the byte cap', () => {
    const cache = new ByteLruCache<string, string>(10, 10, bytesOf);
    cache.set('a', 'aaaa'); // 4
    cache.set('b', 'bbbb'); // 4 (total 8)
    cache.set('c', 'cccc'); // 4 (total 12) → must evict
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('bbbb');
    expect(cache.get('c')).toBe('cccc');
  });

  it('promotes accessed entries to most-recently-used', () => {
    const cache = new ByteLruCache<string, string>(10, 10, bytesOf);
    cache.set('a', 'aaaa');
    cache.set('b', 'bbbb');
    // Touching "a" makes "b" the LRU.
    expect(cache.get('a')).toBe('aaaa');
    cache.set('c', 'cccc'); // evicts b
    expect(cache.get('a')).toBe('aaaa');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('cccc');
  });

  it('replaces existing values for the same key and updates the byte tally', () => {
    const cache = new ByteLruCache<string, string>(20, 20, bytesOf);
    cache.set('a', 'short');
    cache.set('a', 'longer-value');
    expect(cache.get('a')).toBe('longer-value');
    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().bytes).toBe('longer-value'.length);
  });

  it('rejects values larger than maxEntryBytes and drops any prior key', () => {
    const cache = new ByteLruCache<string, string>(100, 5, bytesOf);
    cache.set('a', 'fits');
    cache.set('a', 'far too long to fit');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it('supports delete()', () => {
    const cache = new ByteLruCache<string, string>(10, 10, bytesOf);
    cache.set('a', 'aaaa');
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it('clears all entries', () => {
    const cache = new ByteLruCache<string, string>(10, 10, bytesOf);
    cache.set('a', 'aaaa');
    cache.set('b', 'bbbb');
    cache.clear();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
    expect(cache.get('a')).toBeUndefined();
  });
});
