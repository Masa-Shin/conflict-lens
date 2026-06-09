import { afterEach, describe, expect, it } from 'vitest';

import { createGitRunner } from '../../../src/git/runner';
import { getBaseChange } from '../../../src/mcp/queries';
import { setupScenario, type Scenario } from './repo-fixture';

const runner = createGitRunner('git');
const FIVE = 'l1\nl2\nl3\nl4\nl5\n';

const open: Scenario[] = [];

function start(scenario: Scenario): Scenario {
  open.push(scenario);
  return scenario;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.cleanup();
});

describe('getBaseChange', () => {
  const run = (s: Scenario, file = 'foo.txt') =>
    getBaseChange(runner, s.repo, s.mergeBaseSha, s.baseTipSha, file);

  it('reports a modification with the diff', async () => {
    const s = start(
      setupScenario({
        root: { 'foo.txt': FIVE },
        baseChange: (t) => t.write('foo.txt', 'l1\nl2\nl3-base\nl4\nl5\n'),
      }),
    );
    const change = await run(s);
    expect(change.change).toBe('modified');
    expect(change.diff).toContain('l3-base');
  });

  it('reports a whole-file deletion in full, not empty', async () => {
    const s = start(
      setupScenario({ root: { 'foo.txt': FIVE }, baseChange: (t) => t.remove('foo.txt') }),
    );
    const change = await run(s);
    expect(change.change).toBe('deleted');
    expect(change.diff).toContain('deleted file mode');
    expect(change.diff).toContain('-l3');
  });

  it('reports an addition', async () => {
    const s = start(
      setupScenario({
        root: { 'foo.txt': FIVE },
        baseChange: (t) => t.write('new.txt', 'hello\n'),
      }),
    );
    expect((await run(s, 'new.txt')).change).toBe('added');
  });

  it('handles a filename containing glob characters literally', async () => {
    const s = start(
      setupScenario({
        root: { 'a[b].ts': FIVE },
        baseChange: (t) => t.write('a[b].ts', 'l1\nl2\nl3-base\nl4\nl5\n'),
      }),
    );
    // Without GIT_LITERAL_PATHSPECS the pathspec `a[b].ts` is a char class and
    // matches nothing, yielding change 'none'.
    const change = await run(s, 'a[b].ts');
    expect(change.change).toBe('modified');
    expect(change.diff).toContain('l3-base');
  });
});
