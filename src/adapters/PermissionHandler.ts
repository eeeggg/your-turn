import * as vscode from 'vscode';
import { log } from '@/core/Log';
import type { PermissionPrompt } from '@/core/AcpClientImpl';

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

/**
 * Handles ACP permission requests from agents.
 * Shows VS Code QuickPick for user to select from agent-provided options.
 * Requests are queued so concurrent permission prompts don't clobber each other.
 */
export class PermissionHandler implements PermissionPrompt {
  private queue: Promise<void> = Promise.resolve();

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const result = this.queue.then(() => this.handlePermission(params));
    this.queue = result.then(() => {}, () => {});
    return result.catch((err) => {
      log(`Permission request failed: ${err}`);
      return { outcome: { outcome: 'cancelled' as const } };
    });
  }

  private async handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const config = vscode.workspace.getConfiguration('acp');
    const autoApprove = config.get<string>('autoApprovePermissions', 'none');

    const title = params.toolCall?.title || 'Permission Request';
    log(`requestPermission: ${title} (autoApprove=${autoApprove})`);

    // Auto-approve: pick first allow-type option
    if (autoApprove === 'allowAll') {
      const allowOption = params.options.find(o =>
        o.kind === 'allow_once' || o.kind === 'allow_always'
      );
      if (allowOption) {
        return {
          outcome: {
            outcome: 'selected',
            optionId: allowOption.optionId,
          },
        };
      }
    }

    // Build QuickPick items from agent-provided options
    const items: (vscode.QuickPickItem & { optionId: string })[] = params.options.map(option => {
      const icon = option.kind.startsWith('allow') ? '$(check)' : '$(x)';
      return {
        label: `${icon} ${option.name}`,
        description: option.kind,
        optionId: option.optionId,
      };
    });

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: title,
      title: 'ACP Agent Permission Request',
      ignoreFocusOut: true,
    });

    if (!selection) {
      log('Permission cancelled by user');
      return {
        outcome: { outcome: 'cancelled' },
      };
    }

    log(`Permission selected: ${selection.optionId}`);
    return {
      outcome: {
        outcome: 'selected',
        optionId: selection.optionId,
      },
    };
  }
}
