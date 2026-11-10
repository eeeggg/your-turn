import { connectControl } from '@tests/ui/instrumentation/ControlChannel';
import { SchedulingControl } from '@tests/ui/instrumentation/SchedulingControl';
import { createAgentsView as originalCreateAgentsView } from '@/adapters/SessionTreeProvider';

/** Supplied by the desktop entry; all view behavior still comes from the real adapter. */
export function createAgentsView(...args: Parameters<typeof originalCreateAgentsView>): ReturnType<typeof originalCreateAgentsView> {
  const view = originalCreateAgentsView(...args);
  const port = process.env['UI_TREE_REFRESH_PORT'];
  if (!port) { return view; }
  const controller = controlRefresh(view.provider, Number(port));
  const dispose = view.disposable.dispose.bind(view.disposable);
  view.disposable.dispose = () => { controller.close(); dispose(); };
  return view;
}

function controlRefresh(provider: ReturnType<typeof originalCreateAgentsView>['provider'], port: number) {
  const original = provider.getChildren.bind(provider);
  const scheduling = new SchedulingControl();
  provider.getChildren = (element) => scheduling.hold(() => original(element));
  const channel = connectControl(port, async (command, signal) => {
    if (command === 'hold') {
      scheduling.arm(signal);
      provider.refresh();
      await scheduling.waitForEntry();
      return 'pending';
    }
    if (command === 'release') {
      await scheduling.release();
      return 'settled';
    }
    throw new Error(`Unknown tree refresh command: ${command}`);
  });
  return { close() { scheduling.close(); provider.getChildren = original; channel.close(); } };
}
