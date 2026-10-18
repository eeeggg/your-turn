import * as vscode from 'vscode';
import type { PermissionChooser } from '@/core/PermissionRequests';

export const permissionQuickPick: PermissionChooser = {
  autoApprove() {
    const setting = vscode.workspace.getConfiguration('acp').get<string>('autoApprovePermissions');
    return setting === 'allowAll' ? 'allowAll' : 'ask';
  },

  async choose(title, options) {
    const items = options.map((option) => ({
      label: `${option.kind.startsWith('allow') ? '$(check)' : '$(x)'} ${option.name}`,
      description: option.kind,
      optionId: option.optionId,
    }));
    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: title,
      title: 'ACP Agent Permission Request',
      ignoreFocusOut: true,
    });
    return selection?.optionId;
  },
};
