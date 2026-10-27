/** Runs ordered cleanup without abandoning siblings or replacing the test's original failure. */
export async function cleanup(test: { err?: unknown } | undefined, actions: readonly (() => unknown)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try { await action(); } catch (error) { failures.push(error); }
  }
  if (!failures.length) { return; }
  const error = new AggregateError(failures, 'Failed to clean up integration resources');
  if (test?.err) { console.error(error); } else { throw error; }
}
