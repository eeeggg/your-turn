/**
 * The parts of the VS Code API that core is handed directly, declared here
 * with VS Code's own names and signatures because core cannot import
 * `vscode`. `extension.ts` passes the real `vscode.window`,
 * `vscode.commands` and configuration objects, so the type check fails if
 * these stop matching.
 */

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
}

export interface QuickPickOptions {
  title?: string;
  placeHolder?: string;
}

export interface InputBoxOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
}

export interface MessageOptions {
  modal?: boolean;
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
  showQuickPick<T extends QuickPickItem>(items: readonly T[], options?: QuickPickOptions): PromiseLike<T | undefined>;
  showInputBox(options?: InputBoxOptions): PromiseLike<string | undefined>;
  showInformationMessage<T extends string>(message: string, ...items: T[]): PromiseLike<T | undefined>;
  showWarningMessage<T extends string>(message: string, ...items: T[]): PromiseLike<T | undefined>;
  showWarningMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): PromiseLike<T | undefined>;
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
  update(section: string, value: unknown, configurationTarget: (typeof ConfigurationTarget)[keyof typeof ConfigurationTarget]): PromiseLike<void>;
}
