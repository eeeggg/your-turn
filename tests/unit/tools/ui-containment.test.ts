import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

it.each(['application exit', 'forced shutdown', 'owner socket closes', 'owner socket closes during startup', 'owner socket unavailable', 'bubblewrap unavailable'] as const)('contains a detached descendant after %s', async (ending) => {
  const directory = await mkdtemp(join(tmpdir(), 'acp-ui-containment-'));
  const status = join(directory, 'status');
  const stop = join(directory, 'stop');
  const descendant = `process.send('ready'); setInterval(() => {}, 1000);`;
  const workload = `
    const { spawn } = require('node:child_process');
    const { watch, existsSync } = require('node:fs');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const watcher = watch(${JSON.stringify(directory)}, () => {
      if (existsSync(${JSON.stringify(stop)})) { watcher.close(); process.exit(0); }
    });
    child.once('message', () => console.log('ready'));
  `;
  const child = spawn('/bin/sh', [resolve('tests/ui/electron.sh'), '-e', workload], {
    env: { ...process.env, ...(ending === 'bubblewrap unavailable' ? { PATH: directory } : {}), ACP_UI_EXECUTABLE: process.execPath, ACP_UI_STATUS: status },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', ending === 'owner socket unavailable' ? 'ignore' : 'pipe', 'pipe'],
  });
  if (!child.stdout || !child.stderr) { throw new Error('Missing containment process output'); }
  if (ending === 'owner socket closes during startup') { child.stdio[3]?.destroy(); }
  let output = '';
  child.stderr.setEncoding('utf8').on('data', (text: string) => { output += text; });
  const closed = new Promise<number | null>((resolveExit) => { child.once('close', resolveExit); });
  const watchdog = setTimeout(() => {
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } } }
  }, 10_000);
  onTestFinished(async () => {
    clearTimeout(watchdog);
    child.stdio[3]?.destroy();
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } } }
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  const ready = new Promise<void>((resolveReady, reject) => {
    if (!child.stdout) { throw new Error('Missing containment process output'); }
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => { if (line === 'ready') { lines.close(); resolveReady(); } });
    child.once('close', () => { lines.close(); reject(new Error(`Application closed before readiness: ${output}`)); });
    child.once('error', reject);
  });
  void ready.catch(() => {});
  if (ending === 'bubblewrap unavailable') {
    expect(await closed, output).toBe(125);
    expect(output).toContain('Linux UI tests require bubblewrap');
    return;
  }
  if (ending === 'owner socket unavailable') {
    expect(await closed, output).toBe(125);
    expect(output).toContain('Playwright owner socket is unavailable');
    return;
  }
  if (ending === 'owner socket closes during startup') {
    expect(await closed, output).toBe(137);
    const details = JSON.parse((await readFile(status, 'utf8')).split('\n')[0] ?? '') as { 'child-pid': number };
    await expect(readFile(`/proc/${details['child-pid']}/stat`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    return;
  }
  await ready;
  const details = JSON.parse((await readFile(status, 'utf8')).split('\n')[0] ?? '') as { 'child-pid': number };
  const namespace = details['child-pid'];
  expect(namespace).toBeGreaterThan(1);
  const children = await readFile(`/proc/${namespace}/task/${namespace}/children`, 'utf8');
  expect(children.trim()).not.toBe('');
  const owned: string[] = [];
  async function descendants(pid: string): Promise<void> {
    const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
    for (const child of children) { owned.push(child); await descendants(child); }
  }
  await descendants(String(namespace));
  expect(owned.length).toBeGreaterThanOrEqual(3);
  if (ending === 'application exit') { await writeFile(stop, ''); }
  else if (ending === 'forced shutdown') { process.kill(namespace, 'SIGKILL'); }
  else { child.stdio[3]?.destroy(); }
  expect(await closed, output).toBe(ending === 'application exit' ? 0 : 137);
  await expect(readFile(`/proc/${namespace}/stat`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  for (const pid of owned) {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESRCH') { throw error; }
      return undefined;
    });
    if (stat) { expect(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z'); }
  }
});
