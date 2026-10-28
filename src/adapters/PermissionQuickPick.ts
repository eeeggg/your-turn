import * as vscode from 'vscode';
import type { PermissionOption } from '@/core/acp/AcpDriver';
import type { PermissionChooser } from '@/core/PermissionRequests';

export const permissionQuickPick: PermissionChooser = {
  autoApprove() {
    const setting = vscode.workspace.getConfiguration('acp').get<string>('autoApprovePermissions');
    return setting === 'allowAll' ? 'allowAll' : 'ask';
  },

  async choose({ title, detail }, options, signal) {
    const items = options.map((option) => ({
      label: `${kindIcon(option)}${option.name}`,
      ...(option.kind === 'other' ? {} : { description: option.kind }),
      optionId: option.id,
    }));
    const cancellation = new vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { cancellation.cancel(); }
    try {
      const selection = await vscode.window.showQuickPick(items, {
        placeHolder: title,
        ...(detail ? { prompt: detail } : {}),
        title: 'ACP Agent Permission Request',
        ignoreFocusOut: true,
      }, cancellation.token);
      return selection?.optionId;
    } finally {
      signal.removeEventListener('abort', abort);
      cancellation.dispose();
    }
  },
};

function kindIcon(option: PermissionOption): string {
  if (option.kind === 'other') {
    return '';
  }
  return option.kind.startsWith('allow') ? '$(check) ' : '$(x) ';
}
