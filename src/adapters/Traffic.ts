import * as vscode from 'vscode';
import { clearTraffic, getTrafficJsonl, setTrafficCaptureEnabled } from '@/core/Traffic';

const EXPORT_COMMAND = 'your-turn.exportTraffic';

/** Apply the user's capture setting. Existing records remain when capture is paused. */
function syncTrafficCaptureSetting(): void {
  setTrafficCaptureEnabled(vscode.workspace.getConfiguration('your-turn').get<boolean>('logTraffic', true));
}

/** Register explicit protocol-traffic export and its configuration listener. */
export function registerTrafficAdapter(subscriptions: vscode.Disposable[]): void {
  syncTrafficCaptureSetting();
  subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('your-turn.logTraffic')) {
        syncTrafficCaptureSetting();
      }
    }),
    vscode.commands.registerCommand(EXPORT_COMMAND, exportTraffic),
    { dispose: () => { setTrafficCaptureEnabled(true); clearTraffic(); } },
  );
}

/** Ask for a destination before writing the retained JSONL snapshot. */
export async function exportTraffic(): Promise<void> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const uri = await vscode.window.showSaveDialog({
    title: 'Export ACP Protocol Traffic',
    saveLabel: 'Export',
    filters: { 'JSON Lines': ['jsonl'] },
    ...(workspaceUri && { defaultUri: vscode.Uri.joinPath(workspaceUri, 'acp-traffic.jsonl') }),
  });
  if (!uri) {
    return;
  }
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(getTrafficJsonl()));
}
