import * as assert from 'assert';
import { suite, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { pseudoterminalDisplays } from '@/adapters/PseudoterminalDisplays';
import { observed } from '@tests/integration/observed';
import { cleanup } from '@tests/integration/cleanup';

const shown = (name: string) => observed(vscode.window.onDidChangeActiveTerminal, () => (vscode.window.activeTerminal?.name === name ? true : undefined));

suite('Terminal displays', () => {
  const owned: { terminal: vscode.Terminal; opened: Promise<void>; ptyClosed: Promise<void>; disposed: Promise<void> }[] = [];
  const subscriptions: vscode.Disposable[] = [];

  function open(name: string, closed: () => void = () => {}) {
    const writes: string[] = [];
    let reportOpened: () => void = () => {};
    let reportClosed: () => void = () => {};
    const opened = new Promise<void>((resolve) => { reportOpened = resolve; });
    const ptyClosed = new Promise<void>((resolve) => { reportClosed = resolve; });
    const window = vscode.window as { createTerminal(options: vscode.ExtensionTerminalOptions): vscode.Terminal };
    const createTerminal = window.createTerminal;
    let created: vscode.Terminal | undefined;
    const disposed = new Promise<void>((resolve) => {
      subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal === created) { resolve(); }
      }));
    });
    // Observe the real pty callbacks; terminal creation and activation are not pty readiness.
    window.createTerminal = (options) => {
      subscriptions.push(options.pty.onDidWrite((text) => { writes.push(text); }));
      created = createTerminal({
        ...options,
        pty: {
          ...options.pty,
          open: (dimensions) => {
            options.pty.open(dimensions);
            reportOpened();
          },
          close: () => {
            options.pty.close();
            reportClosed();
          },
        },
      });
      owned.push({ terminal: created, opened, ptyClosed, disposed });
      return created;
    };
    try {
      const display = pseudoterminalDisplays.open(name, closed);
      assert.ok(created);
      return { display, terminal: created, writes, opened, ptyClosed, disposed };
    } finally {
      window.createTerminal = createTerminal;
    }
  }

  teardown(async function () {
    try {
      await cleanup(this.currentTest, [async () => {
        const results = await Promise.allSettled(owned.map(async ({ terminal, opened, ptyClosed, disposed }) => {
          await opened;
          terminal.dispose();
          await Promise.all([ptyClosed, disposed]);
        }));
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length) { throw new AggregateError(failures.map((result) => result.reason as unknown), 'Failed to close terminals'); }
      }]);
    } finally {
      owned.length = 0;
      for (const subscription of subscriptions.splice(0)) { subscription.dispose(); }
    }
  });

  test('opens a VS Code terminal named as asked and shows it, taking writes made before it opens', async () => {
    const { display, terminal, writes, opened } = open('npm test');
    display.write('held until it opens\r\n');
    assert.deepStrictEqual(writes, []);

    await opened;
    await shown('npm test');
    assert.strictEqual(terminal.name, 'npm test');
    assert.deepStrictEqual(writes, ['held until it opens\r\n']);
    display.write('written once open\r\n');
    assert.deepStrictEqual(writes, ['held until it opens\r\n', 'written once open\r\n']);
    assert.strictEqual(vscode.window.terminals.filter((terminal) => terminal.name === 'npm test').length, 1);
  });

  test('brings a terminal forward when shown again', async () => {
    const first = open('first');
    const second = open('second');
    await Promise.all([first.opened, second.opened]);
    await shown('second');

    first.display.show();

    await shown('first');
  });

  test('says when the user closes it', async () => {
    let closeCount = 0;
    const { terminal, opened, ptyClosed, disposed } = open('closing', () => { closeCount += 1; });
    await opened;
    terminal.dispose();

    await Promise.all([ptyClosed, disposed]);
    assert.strictEqual(closeCount, 1);
  });
});
