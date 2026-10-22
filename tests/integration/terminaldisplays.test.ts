import * as assert from 'assert';
import { suite, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { pseudoterminalDisplays } from '@/adapters/PseudoterminalDisplays';

/** VS Code opens, shows and closes terminals asynchronously. */
async function waitFor<T>(find: () => T | undefined, what: string, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const shown = (name: string) => waitFor(() => (vscode.window.activeTerminal?.name === name ? true : undefined), `${name} to be shown`);
const named = (name: string) => waitFor(() => vscode.window.terminals.find((terminal) => terminal.name === name), `a terminal named ${name}`);

suite('Terminal displays', () => {
  teardown(() => {
    for (const terminal of vscode.window.terminals) {
      terminal.dispose();
    }
  });

  test('opens a VS Code terminal named as asked and shows it, taking writes made before it opens', async () => {
    const display = pseudoterminalDisplays.open('npm test', () => {});
    display.write('held until it opens\r\n');

    await shown('npm test');
    display.write('written once open\r\n');
    assert.strictEqual(vscode.window.terminals.filter((terminal) => terminal.name === 'npm test').length, 1);
  });

  test('brings a terminal forward when shown again', async () => {
    const first = pseudoterminalDisplays.open('first', () => {});
    pseudoterminalDisplays.open('second', () => {});
    await shown('second');

    first.show();

    await shown('first');
  });

  test('says when the user closes it', async () => {
    let closed = 0;
    pseudoterminalDisplays.open('closing', () => closed++);
    (await named('closing')).dispose();

    await waitFor(() => (closed === 1 ? true : undefined), 'the close to be heard');
  });
});
