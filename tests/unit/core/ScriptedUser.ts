import type {
  Commands,
  Disposable,
  InputBoxOptions,
  MessageOptions,
  ProgressOptions,
  QuickPick,
  QuickPickItem,
  QuickPickOptions,
  Window,
} from '@/core/VsCodeApi';

type MessageCall = 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage';

export type Call =
  | { call: 'showQuickPick'; items: readonly (string | QuickPickItem)[]; options?: QuickPickOptions }
  | { call: 'createQuickPick'; title?: string; placeholder?: string; busy: boolean; items: readonly QuickPickItem[] }
  | { call: 'showInputBox'; options?: InputBoxOptions }
  | { call: MessageCall; message: string; options?: MessageOptions; items?: string[] }
  | { call: 'withProgress'; options: ProgressOptions }
  | { call: 'executeCommand'; command: string; rest?: unknown[] };

/** A label to pick, labels to pick several, text to enter, a message button to click, or `undefined` to dismiss. */
export type Answer = string | readonly string[] | undefined;

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
  showQuickPick<T extends QuickPickItem>(items: readonly T[], options: QuickPickOptions & { canPickMany: true }): Promise<T[] | undefined>;
  showQuickPick<T extends QuickPickItem>(items: readonly T[], options?: QuickPickOptions): Promise<T | undefined>;
  async showQuickPick<T extends string | QuickPickItem>(items: readonly T[], options?: QuickPickOptions): Promise<T | T[] | undefined> {
    this.calls.push({ call: 'showQuickPick', items, ...(options ? { options } : {}) });
    const answer = this.next('showQuickPick');
    if (answer === undefined) {
      return undefined;
    }
    const pick = (label: string) => {
      const item = items.find((i) => (typeof i === 'string' ? i : i.label) === label);
      if (!item) {
        throw new Error(`no item labelled ${label} to pick`);
      }
      return item;
    };
    if (options?.canPickMany) {
      if (typeof answer === 'string') { throw new Error('a quick pick of several needs a list of labels'); }
      return answer.map(pick);
    }
    if (typeof answer !== 'string') { throw new Error('a quick pick of one needs a single label'); }
    return pick(answer);
  }

  createQuickPick<T extends QuickPickItem>(): QuickPick<T> {
    return new ScriptedQuickPick<T>(this);
  }

  async showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
    this.calls.push({ call: 'showInputBox', ...(options ? { options } : {}) });
    return this.text('showInputBox');
  }

  showInformationMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined>;
  showInformationMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Promise<T | undefined>;
  showInformationMessage<T extends string>(message: string, ...rest: (T | MessageOptions)[]): Promise<T | undefined> {
    const [first, ...others] = rest;
    if (typeof first === 'object') {
      return this.message('showInformationMessage', message, others as T[], first);
    }
    return this.message('showInformationMessage', message, rest as T[]);
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
    const answer = this.text(call);
    if (answer !== undefined && !items.includes(answer as T)) {
      throw new Error(`no button ${answer} to click`);
    }
    return answer as T | undefined;
  }

  /** The next answer, which must be text or a dismissal. */
  private text(call: string): string | undefined {
    const answer = this.next(call);
    if (typeof answer === 'object') { throw new Error(`${call} needs a single answer, not a list`); }
    return answer;
  }

  /** The next answer, left in place until {@link next} takes it. */
  peek(call: string): Answer {
    if (this.answers.length === 0) {
      throw new Error(`unexpected ${call}: no answer left`);
    }
    return this.answers[0];
  }

  next(call: string): Answer {
    this.peek(call);
    return this.answers.shift();
  }
}

/**
 * A quick pick the scripted user answers as soon as it can: a label once an
 * item with it is listed, a dismissal once the list stops loading. An answer
 * that leaves it open, such as an item that cannot be chosen, is followed by
 * the next. Each answer records the quick pick as the user saw it.
 */
class ScriptedQuickPick<T extends QuickPickItem> implements QuickPick<T> {
  title: string | undefined;
  placeholder: string | undefined;
  selectedItems: readonly T[] = [];
  private shownItems: readonly T[] = [];
  private loading = false;
  private open = false;
  private readonly accepted = new Set<() => unknown>();
  private readonly hidden = new Set<() => unknown>();

  constructor(private readonly user: ScriptedUser) {}

  get items(): readonly T[] { return this.shownItems; }
  set items(items: readonly T[]) {
    this.shownItems = items;
    this.answer();
  }

  get busy(): boolean { return this.loading; }
  set busy(busy: boolean) {
    this.loading = busy;
    this.answer();
  }

  onDidAccept(listener: () => unknown): Disposable { return this.listen(this.accepted, listener); }
  onDidHide(listener: () => unknown): Disposable { return this.listen(this.hidden, listener); }

  show(): void {
    this.open = true;
    this.answer();
  }

  dispose(): void {
    if (!this.open) { return; }
    this.open = false;
    this.hidden.forEach((listener) => listener());
  }

  private answer(): void {
    while (this.open) {
      const label = this.user.peek('createQuickPick');
      if (typeof label === 'object') { throw new Error('createQuickPick needs a single label, not a list'); }
      const item = this.shownItems.find((i) => i.label === label);
      if (label !== undefined && !item) {
        if (!this.loading) { throw new Error(`no item labelled ${label} to pick`); }
        return;
      }
      if (label === undefined && this.loading) { return; }
      this.user.next('createQuickPick');
      this.user.calls.push({
        call: 'createQuickPick',
        ...(this.title !== undefined ? { title: this.title } : {}),
        ...(this.placeholder !== undefined ? { placeholder: this.placeholder } : {}),
        busy: this.loading,
        items: this.shownItems,
      });
      if (!item) {
        this.dispose();
        return;
      }
      this.selectedItems = [item];
      this.accepted.forEach((listener) => listener());
    }
  }

  private listen(listeners: Set<() => unknown>, listener: () => unknown): Disposable {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  }
}
