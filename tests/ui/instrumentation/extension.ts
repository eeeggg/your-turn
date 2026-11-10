import type * as vscode from 'vscode';
import { activate as activateExtension } from '@/adapters/ExtensionActivation';
import { createAgentsView } from '@tests/ui/instrumentation/SessionTreeProvider';
import { createReviewPresentation } from '@tests/ui/instrumentation/DiffReviewPresentation';

export { deactivate } from '@/adapters/ExtensionActivation';

export function activate(context: vscode.ExtensionContext) {
  return activateExtension(context, {
    createAgentsView,
    createReviewPresentation,
  });
}
