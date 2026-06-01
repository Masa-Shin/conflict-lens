/**
 * Minimal `vscode` module stand-in so unit tests can exercise coordinators
 * and other VSCode-API-dependent code without launching VSCode itself.
 *
 * Only the surface the project actually imports is implemented. Anything
 * not declared here will be `undefined` at runtime — add to this file as
 * new VSCode APIs get adopted.
 *
 * Wired via the `resolve.alias` entry in `vitest.config.ts`, so every
 * `import * as vscode from 'vscode'` resolves here during tests.
 */

export class Disposable {
  constructor(private readonly fn: () => void) {}
  dispose(): void {
    this.fn();
  }
  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const d of disposables) d.dispose();
    });
  }
}

type Listener<T> = (value: T) => void;

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const l of [...this.listeners]) l(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class MarkdownString {
  isTrusted: boolean | { readonly enabledCommands: readonly string[] } = false;
  supportThemeIcons = false;
  supportHtml = false;
  constructor(public value: string = '') {}
  appendText(text: string): this {
    this.value += text;
    return this;
  }
  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }
}

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(
    startLineOrStart: number | Position,
    startCharacterOrEnd: number | Position,
    endLine?: number,
    endCharacter?: number,
  ) {
    if (typeof startLineOrStart === 'number') {
      this.start = new Position(startLineOrStart, startCharacterOrEnd as number);
      this.end = new Position(endLine as number, endCharacter as number);
    } else {
      this.start = startLineOrStart;
      this.end = startCharacterOrEnd as Position;
    }
  }
}

export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

// ---------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string,
  ) {}

  get fsPath(): string {
    // Match VSCode's behavior just enough for unit tests.
    return this.path;
  }

  toString(): string {
    const auth = this.authority ? `//${this.authority}` : '';
    const q = this.query ? `?${this.query}` : '';
    const f = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}:${auth}${this.path}${q}${f}`;
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  static file(p: string): Uri {
    return new Uri('file', '', p, '', '');
  }

  static parse(s: string): Uri {
    // Crude: `scheme://authority/path?query#fragment`
    const m = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/.exec(s);
    if (!m) return new Uri('file', '', s, '', '');
    return new Uri(m[1] ?? 'file', m[2] ?? '', m[3] ?? '', m[4] ?? '', m[5] ?? '');
  }

  static from(parts: {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      parts.scheme,
      parts.authority ?? '',
      parts.path ?? '',
      parts.query ?? '',
      parts.fragment ?? '',
    );
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path.replace(/\/$/, ''), ...segments].join('/');
    return base.with({ path: joined });
  }
}

// ---------------------------------------------------------------------------
// Decoration / editor / document
// ---------------------------------------------------------------------------

export interface DecorationRenderOptions {
  isWholeLine?: boolean;
  backgroundColor?: ThemeColor | string;
  gutterIconPath?: Uri | string;
  gutterIconSize?: string;
  overviewRulerColor?: ThemeColor | string;
  overviewRulerLane?: OverviewRulerLane;
}

export class TextEditorDecorationType {
  private static _nextId = 1;
  readonly key: string;
  disposed = false;
  appliedToEditors = new Map<unknown, unknown[]>();
  constructor(public readonly options: DecorationRenderOptions) {
    this.key = `dec-${TextEditorDecorationType._nextId++}`;
  }
  dispose(): void {
    this.disposed = true;
  }
}

export interface DecorationOptions {
  range: Range;
  hoverMessage?: MarkdownString | string;
}

// ---------------------------------------------------------------------------
// l10n
// ---------------------------------------------------------------------------

function interpolate(message: string, args: Array<string | number | boolean>): string {
  return message.replace(/\{(\d+)\}/g, (_, idx) => String(args[Number(idx)] ?? ''));
}

export const l10n = {
  t(message: string, ...args: Array<string | number | boolean>): string {
    return interpolate(message, args);
  },
};

// ---------------------------------------------------------------------------
// workspace + window stubs (just enough to construct things; assertions
// in tests usually intercept these themselves via vi.spyOn).
// ---------------------------------------------------------------------------

class WorkspaceConfiguration {
  constructor(private readonly values: Record<string, unknown>) {}
  get<T = unknown>(key: string, defaultValue?: T): T {
    return (this.values[key] as T) ?? (defaultValue as T);
  }
  async update(_key: string, _value: unknown, _target?: ConfigurationTarget): Promise<void> {
    /* no-op for tests */
  }
}

let workspaceConfig: Record<string, unknown> = {};

export const workspace = {
  setConfigForTests(values: Record<string, unknown>): void {
    workspaceConfig = { ...values };
  },
  getConfiguration(_section?: string, _scope?: unknown): WorkspaceConfiguration {
    return new WorkspaceConfiguration(workspaceConfig);
  },
  onDidChangeConfiguration: new EventEmitter<unknown>().event,
  onDidChangeTextDocument: new EventEmitter<unknown>().event,
  onDidCloseTextDocument: new EventEmitter<unknown>().event,
  workspaceFolders: undefined as readonly unknown[] | undefined,
  registerTextDocumentContentProvider(): { dispose(): void } {
    return { dispose() {} };
  },
};

export const window = {
  createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType {
    return new TextEditorDecorationType(options);
  },
  createOutputChannel(_name: string, _options?: unknown): {
    info(): void;
    warn(): void;
    error(): void;
    show(): void;
    dispose(): void;
  } {
    return { info() {}, warn() {}, error() {}, show() {}, dispose() {} };
  },
  createStatusBarItem(): { text: string; tooltip: string; command: string | undefined; show(): void; hide(): void; dispose(): void } {
    return {
      text: '',
      tooltip: '',
      command: undefined,
      show() {},
      hide() {},
      dispose() {},
    };
  },
  visibleTextEditors: [] as readonly unknown[],
  onDidChangeActiveTextEditor: new EventEmitter<unknown>().event,
  onDidChangeVisibleTextEditors: new EventEmitter<unknown>().event,
  onDidChangeWindowState: new EventEmitter<unknown>().event,
  showInformationMessage: async (..._args: unknown[]): Promise<unknown> => undefined,
  showWarningMessage: async (..._args: unknown[]): Promise<unknown> => undefined,
  showQuickPick: async (..._args: unknown[]): Promise<unknown> => undefined,
  registerFileDecorationProvider(): { dispose(): void } {
    return { dispose() {} };
  },
};

export const commands = {
  registerCommand: (_id: string, _fn: (...args: unknown[]) => unknown): { dispose(): void } => ({
    dispose() {},
  }),
  executeCommand: async (..._args: unknown[]): Promise<unknown> => undefined,
};

export const extensions = {
  getExtension(_id: string): unknown {
    return undefined;
  },
};
