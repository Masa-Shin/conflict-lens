import { describe, expect, it } from 'vitest';

import { assertNever, stringifyError } from '../../../src/util/error';

describe('stringifyError', () => {
  it('returns the message of an Error instance', () => {
    expect(stringifyError(new Error('boom'))).toBe('boom');
  });

  it('falls back to String() for non-Error throws', () => {
    expect(stringifyError('plain string')).toBe('plain string');
    expect(stringifyError(42)).toBe('42');
    expect(stringifyError(null)).toBe('null');
    expect(stringifyError(undefined)).toBe('undefined');
    expect(stringifyError({ code: 'EFOO' })).toBe('[object Object]');
  });

  it('uses the message of Error subclasses', () => {
    class CustomError extends Error {
      constructor() {
        super('custom-message');
      }
    }
    expect(stringifyError(new CustomError())).toBe('custom-message');
  });
});

describe('assertNever', () => {
  it('throws with a message identifying the unexpected variant', () => {
    expect(() => assertNever({ kind: 'mystery' } as never)).toThrow(/mystery/);
  });

  it('handles a primitive value without crashing', () => {
    expect(() => assertNever('oops' as never)).toThrow(/oops/);
  });
});
