import * as vscode from 'vscode';
import { DiffReviewPresentation } from '@/adapters/review/DiffReviewPresentation';
import type { Reviews } from '@/core/review/Reviews';
import { connectControl } from '@tests/ui/instrumentation/ControlChannel';
import { createReviewEditors } from '@tests/ui/instrumentation/ReviewPresenters';
import { SchedulingControl } from '@tests/ui/instrumentation/SchedulingControl';

export function createReviewPresentation(reviews: Reviews): DiffReviewPresentation {
  const port = process.env['UI_NATIVE_DIFF_PORT'];
  if (!port) { return new DiffReviewPresentation(reviews, undefined, undefined, createReviewEditors()); }
  const scheduling = new SchedulingControl();
  const presentation = new DiffReviewPresentation(reviews,
    (...args) => scheduling.before(() => vscode.commands.executeCommand('vscode.diff', ...args)),
    undefined, createReviewEditors());
  const show = presentation.showChange.bind(presentation);
  presentation.showChange = (path) => scheduling.accept(() => show(path));
  const showOf = presentation.showChangeOf.bind(presentation);
  presentation.showChangeOf = (...args) => scheduling.accept(() => showOf(...args));
  const control = connectControl(Number(port), async (command, signal) => {
    if (command === 'arm') { scheduling.arm(signal); return 'armed'; }
    if (command === 'pending') { await scheduling.waitForEntry(); return 'pending'; }
    if (command === 'release') {
      await scheduling.release();
      await presentation.settled();
      return 'settled';
    }
    throw new Error(`Unknown native diff command: ${command}`);
  });
  const dispose = presentation.dispose.bind(presentation);
  presentation.dispose = () => { scheduling.close(); control.close(); return dispose(); };
  return presentation;
}
