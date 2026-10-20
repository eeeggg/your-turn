import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentManager, commandNotFound } from '@/core/AgentManager';
import { checkPackageRunner } from '@/core/PackageRunners';

describe('checkPackageRunner, through the real launcher', () => {
  let bin: string;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'acp-runners-'));
    vi.stubEnv('PATH', bin);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(bin, { recursive: true, force: true });
  });

  /** A stand-in for a package runner on the `PATH`, running `script`. */
  function install(name: string, script: string) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  it('finds a package runner that answers --version', async () => {
    install('npx', 'echo 11.19.0');

    expect(await checkPackageRunner(new AgentManager(), 'npx', bin)).toEqual({ works: true });
  });

  it('explains a package runner missing from the PATH VS Code sees', async () => {
    expect(await checkPackageRunner(new AgentManager(), 'uvx', bin)).toEqual({
      works: false,
      reason: `"uvx" was not found: it is not installed, or it is installed where VS Code does not see it. The PATH VS Code sees: ${bin}`,
    });
  });

  it('reports the exit code of a package runner that fails', async () => {
    install('uvx', 'exit 2');

    expect(await checkPackageRunner(new AgentManager(), 'uvx', bin)).toEqual({
      works: false,
      reason: '"uvx --version" exited with code 2; its output is in the ACP log (ACP: Show Log).',
    });
  });

  it('names the PATH VS Code sees as of the explanation', () => {
    vi.stubEnv('PATH', '/usr/bin:/bin');

    expect(commandNotFound('npx')).toBe(
      '"npx" was not found: it is not installed, or it is installed where VS Code does not see it. The PATH VS Code sees: /usr/bin:/bin',
    );
  });
});
