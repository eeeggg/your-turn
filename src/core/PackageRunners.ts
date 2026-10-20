import { commandNotFound, type AgentLauncher } from './AgentManager';

/** The package runners an agent from the agent registry can be added through. */
export type PackageRunner = 'npx' | 'uvx';

/** Whether a package runner works, and if not, why. */
export type PackageRunnerCheck = { works: true } | { works: false; reason: string };

/** Run `<runner> --version` the way agents are launched, so what it finds is what an agent added through it would. */
export function checkPackageRunner(launcher: AgentLauncher, runner: PackageRunner, cwd: string): Promise<PackageRunnerCheck> {
  return new Promise((resolve) => {
    let reason: string | undefined;
    launcher.launch(runner, { command: runner, args: ['--version'] }, cwd, {
      error: (error) => { reason = error.code === 'ENOENT' ? commandNotFound(runner) : error.message; },
      exit: (code) => {
        if (reason === undefined && code !== 0) {
          reason = `"${runner} --version" exited with code ${String(code)}; its output is in the ACP log (ACP: Show Log).`;
        }
        resolve(reason === undefined ? { works: true } : { works: false, reason });
      },
    });
  });
}
