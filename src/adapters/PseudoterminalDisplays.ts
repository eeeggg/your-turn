import * as vscode from 'vscode';
import type { TerminalDisplays } from '@/core/ProcessTerminals';

export const pseudoterminalDisplays: TerminalDisplays = {
  open(title, commandLine) {
    const writes = new vscode.EventEmitter<string>();
    // VS Code ignores writes made before the pseudoterminal opens, so hold them until it does.
    let pending: string[] | undefined = [`$ ${commandLine}\r\n`];

    const terminal = vscode.window.createTerminal({
      name: title,
      pty: {
        onDidWrite: writes.event,
        open: () => {
          const held = pending ?? [];
          pending = undefined;
          for (const text of held) {
            writes.fire(text);
          }
        },
        close: () => {},
      },
    });

    return {
      write: (text) => {
        const converted = text.replace(/\r?\n/g, '\r\n');
        if (pending) {
          pending.push(converted);
        } else {
          writes.fire(converted);
        }
      },
      dispose: () => {
        terminal.dispose();
        writes.dispose();
      },
    };
  },
};
