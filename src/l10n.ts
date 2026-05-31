import * as vscode from 'vscode';

/**
 * Thin wrapper around vscode.l10n.t.
 *
 * Centralizing translation calls makes it easier to:
 * - audit all user-facing strings,
 * - swap in a stub during unit tests,
 * - keep the call sites short.
 */
export function t(message: string, ...args: Array<string | number | boolean>): string {
  return vscode.l10n.t(message, ...args);
}
