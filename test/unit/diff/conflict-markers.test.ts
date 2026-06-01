import { describe, expect, it } from 'vitest';

import { parseConflictMarkers } from '../../../src/diff/conflict-markers';

describe('parseConflictMarkers', () => {
  it('returns [] for an empty input', () => {
    expect(parseConflictMarkers('')).toEqual([]);
  });

  it('returns [] when there are no conflict markers', () => {
    expect(parseConflictMarkers('plain\ntext\nno markers\n')).toEqual([]);
  });

  it('locates a single conflict on the changed line', () => {
    // Ours: A, B-ours, C   (line 2 is the conflict)
    const content = [
      'A',
      '<<<<<<< ours',
      'B-ours',
      '||||||| base',
      'B',
      '=======',
      'B-theirs',
      '>>>>>>> theirs',
      'C',
      '',
    ].join('\n');
    expect(parseConflictMarkers(content)).toEqual([
      { startLine: 2, endLine: 2, insertion: false },
    ]);
  });

  it('locates a multi-line conflict', () => {
    // Ours: A, B-ours, C-ours, D
    const content = [
      'A',
      '<<<<<<< ours',
      'B-ours',
      'C-ours',
      '||||||| base',
      'B',
      'C',
      '=======',
      'B-theirs',
      'C-theirs',
      '>>>>>>> theirs',
      'D',
      '',
    ].join('\n');
    expect(parseConflictMarkers(content)).toEqual([
      { startLine: 2, endLine: 3, insertion: false },
    ]);
  });

  it('marks an empty ours section as an insertion', () => {
    // Ours: A, C — theirs adds a B' line where ours has nothing.
    const content = [
      'A',
      '<<<<<<< ours',
      '||||||| base',
      'B',
      '=======',
      'B-theirs',
      '>>>>>>> theirs',
      'C',
      '',
    ].join('\n');
    // The insertion lands between ours line 1 and line 2; anchor it on
    // the survivor line (line 2 = "C").
    expect(parseConflictMarkers(content)).toEqual([
      { startLine: 2, endLine: 2, insertion: true },
    ]);
  });

  it('finds multiple conflicts in the same file', () => {
    const content = [
      'A',
      '<<<<<<< ours',
      'B-ours',
      '||||||| base',
      'B',
      '=======',
      'B-theirs',
      '>>>>>>> theirs',
      'C',
      '<<<<<<< ours',
      'D-ours',
      '||||||| base',
      'D',
      '=======',
      'D-theirs',
      '>>>>>>> theirs',
      'E',
      '',
    ].join('\n');
    expect(parseConflictMarkers(content)).toEqual([
      { startLine: 2, endLine: 2, insertion: false },
      // After the first conflict resolves, ours counter is at 3 (C),
      // then 4 when the second conflict opens.
      { startLine: 4, endLine: 4, insertion: false },
    ]);
  });

  it('handles a conflict at end-of-file without trailing newline', async () => {
    const content = [
      'A',
      '<<<<<<< ours',
      'B-ours',
      '||||||| base',
      '=======',
      'B-theirs',
      '>>>>>>> theirs',
    ].join('\n'); // no trailing newline
    expect(parseConflictMarkers(content)).toEqual([
      { startLine: 2, endLine: 2, insertion: false },
    ]);
  });

  it('tolerates CRLF line endings', () => {
    const content =
      'A\r\n<<<<<<< ours\r\nB-ours\r\n||||||| base\r\nB\r\n=======\r\nB-theirs\r\n>>>>>>> theirs\r\nC\r\n';
    expect(parseConflictMarkers(content)).toEqual([
      { startLine: 2, endLine: 2, insertion: false },
    ]);
  });

  it('also works without --diff3 (no ||||||| section)', () => {
    const content = [
      'A',
      '<<<<<<< ours',
      'B-ours',
      '=======',
      'B-theirs',
      '>>>>>>> theirs',
      'C',
      '',
    ].join('\n');
    expect(parseConflictMarkers(content)).toEqual([
      { startLine: 2, endLine: 2, insertion: false },
    ]);
  });

  it('does not mistake 6 or 8 equals for a divider', () => {
    const content = [
      'A',
      '======',
      'B',
      '========',
      'C',
      '',
    ].join('\n');
    expect(parseConflictMarkers(content)).toEqual([]);
  });

  it('does not mistake `<<<<<<<X` (no space) for a marker', () => {
    const content = [
      'A',
      '<<<<<<<no_space_label',
      'B',
      '',
    ].join('\n');
    expect(parseConflictMarkers(content)).toEqual([]);
  });

  it('treats a bare `<<<<<<<` (no label) as a valid marker', () => {
    const content = [
      'A',
      '<<<<<<<',
      'B-ours',
      '|||||||',
      'B',
      '=======',
      'B-theirs',
      '>>>>>>>',
      'C',
      '',
    ].join('\n');
    expect(parseConflictMarkers(content)).toEqual([
      { startLine: 2, endLine: 2, insertion: false },
    ]);
  });

  it('drops an unterminated conflict block silently', () => {
    const content = [
      'A',
      '<<<<<<< ours',
      'B-ours',
      // no closing markers
      '',
    ].join('\n');
    expect(parseConflictMarkers(content)).toEqual([]);
  });

  it('clamps an end-of-file insertion anchor onto the last ours line', () => {
    // Ours = ["A", "B"]; theirs appends a third line after B.
    const content = [
      'A',
      'B',
      '<<<<<<< ours',
      '||||||| base',
      '=======',
      'C-theirs',
      '>>>>>>> theirs',
      '',
    ].join('\n');
    expect(parseConflictMarkers(content)).toEqual([
      // Without clamping this would have been {3, 3, insertion: true},
      // pointing one line past the buffer's last real line.
      { startLine: 2, endLine: 2, insertion: true },
    ]);
  });

  it('drops an end-of-file insertion entirely when ours is empty', () => {
    const content = [
      '<<<<<<< ours',
      '||||||| base',
      '=======',
      'C-theirs',
      '>>>>>>> theirs',
      '',
    ].join('\n');
    expect(parseConflictMarkers(content)).toEqual([]);
  });
});
