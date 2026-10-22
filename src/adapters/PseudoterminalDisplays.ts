import * as vscode from 'vscode';
import type { TerminalDisplays } from '@/core/AgentTerminals';

/** Read-only VS Code terminals: pseudoterminals that take no input, written as they are. */
export const pseudoterminalDisplays: TerminalDisplays = {
  open(name, closed) {
    const writes = new vscode.EventEmitter<string>();
    // VS Code drops writes made before a pseudoterminal opens, so they are held until it does.
    let held: string[] | undefined = [];

    const terminal = vscode.window.createTerminal({
      name,
      pty: {
        onDidWrite: writes.event,
        open: () => {
          const texts = held ?? [];
          held = undefined;
          for (const text of texts) {
            writes.fire(text);
          }
        },
        close: () => {
          writes.dispose();
          closed();
        },
      },
    });
    terminal.show();

    return {
      write: (text) => {
        if (held) {
          held.push(text);
        } else {
          writes.fire(text);
        }
      },
      show: () => terminal.show(),
    };
  },
};
