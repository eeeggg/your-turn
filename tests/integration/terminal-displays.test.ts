import * as assert from 'assert';
import { suite, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { pseudoterminalDisplays } from '@/adapters/PseudoterminalDisplays';
import { observed } from './observed';

const shown = (name: string) => observed(vscode.window.onDidChangeActiveTerminal, () => (vscode.window.activeTerminal?.name === name ? true : undefined));
const named = (name: string) => observed(vscode.window.onDidOpenTerminal, () => vscode.window.terminals.find((terminal) => terminal.name === name));

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
    let reportClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => { reportClosed = resolve; });
    pseudoterminalDisplays.open('closing', reportClosed);
    (await named('closing')).dispose();

    await closed;
  });
});
