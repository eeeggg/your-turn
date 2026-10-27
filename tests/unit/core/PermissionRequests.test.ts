import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { PermissionOption, PermissionOutcome, PermissionRequest } from '@/core/acp/AcpDriver';
import { PermissionRequests, type AutoApprove, type PermissionChooser, type PermissionPrompt } from '@/core/PermissionRequests';

const allowOnce: PermissionOption = { id: 'allow', name: 'Allow', kind: 'allow_once' };
const allowAlways: PermissionOption = { id: 'always', name: 'Always allow', kind: 'allow_always' };
const reject: PermissionOption = { id: 'reject', name: 'Reject', kind: 'reject_once' };
const sandboxed: PermissionOption = { id: 'sandbox', name: 'Run in the sandbox', kind: 'other' };

function request(
  title: string | null,
  options: PermissionOption[] = [reject, allowOnce],
  about: Partial<Pick<PermissionRequest, 'subject' | 'description'>> = {},
): PermissionRequest {
  return { sessionId: 's1', title, description: null, subject: null, options, ...about };
}

const selected = (optionId: string) => ({ kind: 'selected', optionId });
const cancelled = { kind: 'cancelled' };

/** A chooser the test answers by hand, one pending choice at a time. */
function manualRequests(autoApprove: AutoApprove = 'ask') {
  interface Pending {
    prompt: PermissionPrompt;
    options: readonly PermissionOption[];
    answer(optionId: string | undefined): void;
    fail(error: Error): void;
  }
  const pending: Pending[] = [];
  const waiting: ((choice: Pending) => void)[] = [];
  const replies = new Set<Promise<PermissionOutcome>>();
  let closing = false;
  const chooser: PermissionChooser = {
    autoApprove: () => autoApprove,
    choose: (prompt, options) => closing ? Promise.resolve(undefined) : new Promise((resolve, reject) => {
      const choice = { prompt, options, answer: resolve, fail: reject };
      pending.push(choice);
      waiting.shift()?.(choice);
    }),
  };
  const nextChoice = () => new Promise<Pending>((resolve) => waiting.push(resolve));
  const requests = new PermissionRequests(chooser);
  const ask = (request: PermissionRequest) => {
    const reply = requests.requestPermission(request);
    replies.add(reply);
    void reply.then(() => replies.delete(reply));
    return reply;
  };
  const close = async () => {
    closing = true;
    for (const choice of pending) { choice.answer(undefined); }
    await Promise.all(replies);
    expect(replies.size, 'permission requests left pending by the test').toBe(0);
  };
  onTestFinished(close);
  return { ask, pending, nextChoice, close };
}

describe('PermissionRequests', () => {
  it("returns the option the user chooses, showing the request's title", async () => {
    const { ask, pending, nextChoice } = manualRequests();
    const shown = nextChoice();

    const answer = ask(request('Edit a.ts'));
    const choice = await shown;
    expect([choice.prompt, choice.options]).toEqual([{ title: 'Edit a.ts', detail: null }, [reject, allowOnce]]);
    pending[0]?.answer('allow');

    expect(await answer).toEqual(selected('allow'));
  });

  it('falls back to a generic title when the request has none', async () => {
    const { ask, nextChoice } = manualRequests();
    const shown = nextChoice();

    const answer = ask(request(null));

    const choice = await shown;
    expect(choice.prompt.title).toBe('Permission Request');
    choice.answer(undefined);
    expect(await answer).toEqual(cancelled);
  });

  it.each([
    [{ subject: 'npm test in /work', description: 'Needs the network' }, 'npm test in /work — Needs the network'],
    [{ subject: 'npm test in /work' }, 'npm test in /work'],
    [{ description: 'Needs the network' }, 'Needs the network'],
    [{ subject: '', description: '' }, null],
  ])('shows what the request is about, then why, as the detail: %o', async (about, detail) => {
    const { ask, nextChoice } = manualRequests();
    const shown = nextChoice();

    const answer = ask(request('Run command?', [reject, allowOnce], about));

    const choice = await shown;
    expect(choice.prompt).toEqual({ title: 'Run command?', detail });
    choice.answer(undefined);
    expect(await answer).toEqual(cancelled);
  });

  it('settles the active and queued test requests when an assertion interrupts them', async () => {
    const { ask, nextChoice, close } = manualRequests();
    const shown = nextChoice();
    const first = ask(request('first'));
    const second = ask(request('second'));
    const failure = new Error('assertion failed before answering');
    const interrupted = async () => {
      try {
        await shown;
        throw failure;
      } finally {
        await close();
      }
    };

    await expect(interrupted()).rejects.toBe(failure);
    expect(await Promise.all([first, second])).toEqual([cancelled, cancelled]);
  });

  it('reports a dismissed choice as cancelled', async () => {
    const { ask, nextChoice } = manualRequests();
    const shown = nextChoice();

    const answer = ask(request('Edit a.ts'));
    (await shown).answer(undefined);

    expect(await answer).toEqual(cancelled);
  });

  it('asks about one request at a time, in the order they arrive', async () => {
    const { ask, pending, nextChoice } = manualRequests();
    const firstShown = nextChoice();

    const first = ask(request('first'));
    const second = ask(request('second'));
    await firstShown;
    expect(pending.map((p) => p.prompt.title)).toEqual(['first']);

    const secondShown = nextChoice();
    pending[0]?.answer('allow');
    expect(await first).toEqual(selected('allow'));
    await secondShown;
    expect(pending.map((p) => p.prompt.title)).toEqual(['first', 'second']);

    pending[1]?.answer('reject');
    expect(await second).toEqual(selected('reject'));
  });

  it('cancels a request whose choice fails, and goes on to the next', async () => {
    const { ask, pending, nextChoice } = manualRequests();
    const failingShown = nextChoice();

    const failing = ask(request('failing'));
    const next = ask(request('next'));
    await failingShown;
    const nextShown = nextChoice();
    pending[0]?.fail(new Error('quick pick broke'));

    expect(await failing).toEqual(cancelled);
    await nextShown;
    pending[1]?.answer('allow');
    expect(await next).toEqual(selected('allow'));
  });

  it('allows without asking when auto-approve is allowAll, picking the first allow option', async () => {
    const choose = vi.fn<PermissionChooser['choose']>();
    const requests = new PermissionRequests({ autoApprove: () => 'allowAll', choose });

    const answer = await requests.requestPermission(request('Edit a.ts', [reject, allowAlways, allowOnce]));

    expect(answer).toEqual(selected('always'));
    expect(choose).not.toHaveBeenCalled();
  });

  it('still asks under allowAll when the agent offers no allow option, not taking an option of a kind it added', async () => {
    const choose = vi.fn<PermissionChooser['choose']>(async () => 'reject');
    const requests = new PermissionRequests({ autoApprove: () => 'allowAll', choose });

    const answer = await requests.requestPermission(request('Delete a.ts', [sandboxed, reject]));

    expect(choose).toHaveBeenCalledExactlyOnceWith({ title: 'Delete a.ts', detail: null }, [sandboxed, reject]);
    expect(answer).toEqual(selected('reject'));
  });

  it('reads the auto-approve setting for every request', async () => {
    let setting: AutoApprove = 'ask';
    const choose = vi.fn<PermissionChooser['choose']>(async () => 'reject');
    const requests = new PermissionRequests({ autoApprove: () => setting, choose });

    expect(await requests.requestPermission(request('first'))).toEqual(selected('reject'));
    setting = 'allowAll';
    expect(await requests.requestPermission(request('second'))).toEqual(selected('allow'));
    expect(choose).toHaveBeenCalledTimes(1);
  });
});
