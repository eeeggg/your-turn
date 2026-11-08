import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

async function verify(overrides: Record<string, string> = {}) {
  const workflow = await readFile('.github/workflows/publish.yml', 'utf8').catch(() => '');
  const script = workflow.split('        run: |\n').find((block) => block.startsWith('          python -'))
    ?.split("          PY\n")[0]?.split('\n').slice(1).map((line) => line.slice(10)).join('\n');
  expect(script, 'Publishing workflow must provide its candidate verifier').toBeTruthy();
  const root = await mkdtemp(join(tmpdir(), 'publish-workflow-'));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const env = {
    ...process.env, RELEASE_TAG: 'v0.4.0', RELEASE_ASSET: 'candidate.vsix',
    RELEASE_COMMIT: 'a'.repeat(40), RELEASE_CHANNEL: 'release',
    GITHUB_REF: 'refs/heads/master', GITHUB_REPOSITORY: 'eeeggg/your-turn',
    ...overrides,
  };
  const fixture = spawnSync('python', ['-c', `
import hashlib,json,os,zipfile
p={'publisher':'eeeggg','name':'your-turn','version':os.environ.get('PACKAGE_VERSION','0.4.0')}
with zipfile.ZipFile('candidate.vsix','w') as z:
 z.writestr('extension/package.json',json.dumps(p))
 z.writestr('extension/changelog.md','## 0.4.0 — 2026-11-07 — First public beta')
 z.writestr('extension.vsixmanifest','<PackageManifest><Metadata><Properties><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="'+os.environ.get('PRE_RELEASE','false')+'"/></Properties></Metadata></PackageManifest>')
json.dump({'draft':False,'prerelease':False,'tag_name':'v0.4.0','assets':[{'name':'candidate.vsix','state':'uploaded'}]},open('release.json','w'))
json.dump({'sha':'a'*40},open('source.json','w'))
json.dump(p,open('source-package.json','w'))
json.dump({'version':'0.4.0','packages':{'':{'version':'0.4.0'}}},open('source-lock.json','w'))
print(hashlib.sha256(open('candidate.vsix','rb').read()).hexdigest())
`], { cwd: root, env, encoding: 'utf8' });
  expect(fixture.status, fixture.stderr).toBe(0);
  return spawnSync('python', ['-c', script ?? ''], {
    cwd: root, env: { ...env, RELEASE_SHA256: fixture.stdout.trim(), ...overrides }, encoding: 'utf8',
  });
}

it('accepts the exact regular release candidate', async () => {
  const result = await verify();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Verified eeeggg.your-turn 0.4.0');
});

it.each([
  { RELEASE_SHA256: '0'.repeat(64) },
  { RELEASE_COMMIT: 'b'.repeat(40) },
  { RELEASE_TAG: 'v0.4.1' },
  { PACKAGE_VERSION: '0.4.1' },
  { PRE_RELEASE: 'true' },
  { GITHUB_REF: 'refs/heads/dev' },
  { GITHUB_REPOSITORY: 'someone/your-turn' },
  { RELEASE_CHANNEL: 'pre-release' },
  { RELEASE_ASSET: '../candidate.vsix' },
])('rejects a mismatched or unsafe publication request: %j', async (overrides) => {
  const result = await verify(overrides);
  expect(result.status).not.toBe(0);
});
