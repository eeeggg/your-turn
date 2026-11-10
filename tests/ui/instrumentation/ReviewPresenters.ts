import * as vscode from 'vscode';
import { createReviewEditors as originalCreateReviewEditors } from '@/adapters/review/ReviewPresenters';
import { connectControl } from '@tests/ui/instrumentation/ControlChannel';
import { SchedulingControl } from '@tests/ui/instrumentation/SchedulingControl';

export function createReviewEditors(...args: Parameters<typeof originalCreateReviewEditors>): ReturnType<typeof originalCreateReviewEditors> {
  const port = process.env['UI_REVIEW_PRESENTATION_PORT'];
  if (!port) { return originalCreateReviewEditors(...args); }
  const showTextDocument = args[2] ?? ((uri, options) => vscode.window.showTextDocument(uri, options));
  const scheduling = new SchedulingControl();
  let completed: Promise<void> | undefined;
  const editors = originalCreateReviewEditors(args[0], args[1], (uri, options) => scheduling.hold(() => {
    const result = Promise.resolve(showTextDocument(uri, options));
    completed ??= result.then(() => {}, () => {});
    return result;
  }));
  const show = editors.showChange;
  editors.showChange = (path) => {
    return scheduling.accept(() => show(path));
  };
  const showOf = editors.showChangeOf;
  editors.showChangeOf = (...values) => scheduling.accept(() => showOf(...values));
  const control = connectControl(Number(port), async (command, signal) => {
    if (command === 'arm') {
      scheduling.arm(signal);
      completed = undefined;
      return 'armed';
    }
    if (command === 'pending') { await scheduling.waitForEntry(); await completed; return 'pending'; }
    if (command === 'release') {
      await scheduling.release();
      return 'settled';
    }
    throw new Error(`Unknown presentation command: ${command}`);
  });
  const dispose = editors.dispose;
  editors.dispose = async () => { scheduling.close(); control.close(); await dispose(); };
  return editors;
}
