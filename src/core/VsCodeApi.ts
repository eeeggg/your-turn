/**
 * The parts of the VS Code API that core is handed directly, declared here
 * with VS Code's own names and signatures because core cannot import
 * `vscode`. `extension.ts` passes the real `vscode.window`,
 * `vscode.commands` and configuration objects, so the type check fails if
 * these stop matching.
 */

/** The `vscode.QuickPickItemKind` values core uses. */
export const QuickPickItemKind = { Separator: -1 } as const;

export interface QuickPickItem {
  label: string;
  kind?: (typeof QuickPickItemKind)[keyof typeof QuickPickItemKind];
  description?: string;
  detail?: string;
}

export interface QuickPickOptions {
  title?: string;
  placeHolder?: string;
  canPickMany?: boolean;
}

export interface Disposable {
  dispose(): unknown;
}

/** A quick pick whose items can change while it is open, as `vscode.window.createQuickPick` makes. */
export interface QuickPick<T extends QuickPickItem> {
  title: string | undefined;
  placeholder: string | undefined;
  items: readonly T[];
  busy: boolean;
  readonly selectedItems: readonly T[];
  onDidAccept(listener: () => unknown): Disposable;
  onDidHide(listener: () => unknown): Disposable;
  show(): void;
  dispose(): void;
}

export interface InputBoxOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
}

/** The `vscode.ProgressLocation` values core uses. */
export const ProgressLocation = { Notification: 15 } as const;

export interface ProgressOptions {
  location: (typeof ProgressLocation)[keyof typeof ProgressLocation];
  title?: string;
  cancellable?: boolean;
}

export interface Window {
  showQuickPick(items: readonly string[], options?: QuickPickOptions): PromiseLike<string | undefined>;
  showQuickPick<T extends QuickPickItem>(items: readonly T[], options: QuickPickOptions & { canPickMany: true }): PromiseLike<T[] | undefined>;
  showQuickPick<T extends QuickPickItem>(items: readonly T[], options?: QuickPickOptions): PromiseLike<T | undefined>;
  createQuickPick<T extends QuickPickItem>(): QuickPick<T>;
  showInputBox(options?: InputBoxOptions): PromiseLike<string | undefined>;
  showInformationMessage<T extends string>(message: string, ...items: T[]): PromiseLike<T | undefined>;
  showWarningMessage<T extends string>(message: string, ...items: T[]): PromiseLike<T | undefined>;
  showErrorMessage<T extends string>(message: string, ...items: T[]): PromiseLike<T | undefined>;
  withProgress<R>(options: ProgressOptions, task: () => PromiseLike<R>): PromiseLike<R>;
}

export interface Commands {
  executeCommand(command: string, ...rest: unknown[]): PromiseLike<unknown>;
}

/** The `vscode.ConfigurationTarget` values core uses. */
export const ConfigurationTarget = { Global: 1 } as const;

export interface WorkspaceConfiguration {
  get<T>(section: string): T | undefined;
  inspect<T>(section: string): { globalValue?: T; workspaceValue?: T } | undefined;
  update(section: string, value: unknown, configurationTarget: (typeof ConfigurationTarget)[keyof typeof ConfigurationTarget]): PromiseLike<void>;
}
