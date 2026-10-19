import type {
  Commands,
  InputBoxOptions,
  MessageOptions,
  ProgressOptions,
  QuickPickItem,
  QuickPickOptions,
  Window,
} from '@/core/VsCodeApi';

type MessageCall = 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage';

export type Call =
  | { call: 'showQuickPick'; items: readonly (string | QuickPickItem)[]; options?: QuickPickOptions }
  | { call: 'showInputBox'; options?: InputBoxOptions }
  | { call: MessageCall; message: string; options?: MessageOptions; items?: string[] }
  | { call: 'withProgress'; options: ProgressOptions }
  | { call: 'executeCommand'; command: string; rest?: unknown[] };

/** A label to pick, text to enter, a message button to click, or `undefined` to dismiss. */
export type Answer = string | undefined;

/**
 * A user who answers in advance, standing in for `vscode.window` and
 * `vscode.commands` and recording every call in order. A question with no
 * answer left fails the test; a message without buttons asks nothing.
 */
export class ScriptedUser implements Window, Commands {
  readonly calls: Call[] = [];
  private readonly answers: Answer[] = [];

  answer(...answers: Answer[]): this {
    this.answers.push(...answers);
    return this;
  }

  /** The calls since the last call to `take`. */
  take(): Call[] {
    return this.calls.splice(0);
  }

  showQuickPick(items: readonly string[], options?: QuickPickOptions): Promise<string | undefined>;
  showQuickPick<T extends QuickPickItem>(items: readonly T[], options?: QuickPickOptions): Promise<T | undefined>;
  async showQuickPick<T extends string | QuickPickItem>(items: readonly T[], options?: QuickPickOptions): Promise<T | undefined> {
    this.calls.push({ call: 'showQuickPick', items, ...(options ? { options } : {}) });
    const answer = this.next('showQuickPick');
    if (answer === undefined) {
      return undefined;
    }
    const item = items.find((i) => (typeof i === 'string' ? i : i.label) === answer);
    if (!item) {
      throw new Error(`no item labelled ${answer} to pick`);
    }
    return item;
  }

  async showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
    this.calls.push({ call: 'showInputBox', ...(options ? { options } : {}) });
    return this.next('showInputBox');
  }

  showInformationMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined> {
    return this.message('showInformationMessage', message, items);
  }

  showWarningMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined>;
  showWarningMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Promise<T | undefined>;
  showWarningMessage<T extends string>(message: string, ...rest: (T | MessageOptions)[]): Promise<T | undefined> {
    const [first, ...others] = rest;
    if (typeof first === 'object') {
      return this.message('showWarningMessage', message, others as T[], first);
    }
    return this.message('showWarningMessage', message, rest as T[]);
  }

  showErrorMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined> {
    return this.message('showErrorMessage', message, items);
  }

  async withProgress<R>(options: ProgressOptions, task: () => PromiseLike<R>): Promise<R> {
    this.calls.push({ call: 'withProgress', options });
    return task();
  }

  async executeCommand(command: string, ...rest: unknown[]): Promise<unknown> {
    this.calls.push({ call: 'executeCommand', command, ...(rest.length > 0 ? { rest } : {}) });
    return undefined;
  }

  private async message<T extends string>(call: MessageCall, message: string, items: T[], options?: MessageOptions): Promise<T | undefined> {
    this.calls.push({ call, message, ...(options ? { options } : {}), ...(items.length > 0 ? { items } : {}) });
    if (items.length === 0) {
      return undefined;
    }
    const answer = this.next(call);
    if (answer !== undefined && !items.includes(answer as T)) {
      throw new Error(`no button ${answer} to click`);
    }
    return answer as T | undefined;
  }

  private next(call: string): Answer {
    if (this.answers.length === 0) {
      throw new Error(`unexpected ${call}: no answer left`);
    }
    return this.answers.shift();
  }
}
