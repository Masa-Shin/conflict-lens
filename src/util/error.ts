/** Convert an unknown thrown value to a printable message. */
export function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Exhaustiveness helper for switch statements over discriminated unions.
 * If a new variant is added without updating the switch, this call site
 * fails to type-check.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union variant: ${JSON.stringify(value)}`);
}
