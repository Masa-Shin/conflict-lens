import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { relativeIfWithin } from '../../../src/ui/file-decoration-helpers';

describe('relativeIfWithin', () => {
  const repo = path.resolve('/tmp/myrepo');

  it('returns forward-slashed relative path for a file under the repo', () => {
    const file = path.join(repo, 'src', 'main.ts');
    expect(relativeIfWithin(file, repo)).toBe('src/main.ts');
  });

  it('returns undefined for the repo root itself', () => {
    expect(relativeIfWithin(repo, repo)).toBeUndefined();
  });

  it('returns undefined for a path above the repo root', () => {
    expect(relativeIfWithin(path.resolve('/tmp'), repo)).toBeUndefined();
  });

  it('returns undefined for a sibling path with a shared prefix', () => {
    expect(relativeIfWithin(path.resolve('/tmp/myrepo-other/file'), repo)).toBeUndefined();
  });

  it('handles deeply nested paths', () => {
    const file = path.join(repo, 'a', 'b', 'c', 'd.ts');
    expect(relativeIfWithin(file, repo)).toBe('a/b/c/d.ts');
  });
});
