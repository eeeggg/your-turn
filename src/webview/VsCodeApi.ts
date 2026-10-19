import type { WebviewToExtensionMessage } from '@/shared/WebviewMessages';

// VS Code throws if a page calls acquireVsCodeApi twice.
const api = acquireVsCodeApi();

export function postMessage(message: WebviewToExtensionMessage): void {
  api.postMessage(message);
}
