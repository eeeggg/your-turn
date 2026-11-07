import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import hostedGitInfo from 'hosted-git-info';

execFileSync(process.execPath, [
  'node_modules/generate-license-file/bin/generate-license-file',
  '--config', '.glf.json', '--overwrite', '--ci',
], { stdio: 'inherit' });

/** @param {string} url */
async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Could not retrieve ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

/** @typedef {{ name: string, version: string, repository?: string | { url?: string }, commit?: string, gitHead?: string }} Manifest */
/** @typedef {{ package: string, files?: string[], repositoryFiles?: string[], url?: string }} AdditionalNotice */

/**
 * @param {Manifest} manifest
 * @param {string} file
 */
function repositoryFileUrl(manifest, file) {
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const commit = manifest.commit ?? manifest.gitHead;
  if (!repository || !commit) {
    throw new Error(`Missing repository or recorded commit for ${manifest.name}`);
  }
  const info = hostedGitInfo.fromUrl(`${repository.split('#')[0] ?? repository}#${commit}`);
  const url = info?.file(file);
  if (!url) {
    throw new Error(`Unsupported repository for ${manifest.name}: ${repository}`);
  }
  return url;
}

/** @type {unknown} */
const additionalJson = JSON.parse(await readFile('.glf.additional.json', 'utf8'));
const additional = /** @type {AdditionalNotice[]} */ (additionalJson);
for (const entry of additional) {
  /** @type {unknown} */
  const manifestJson = JSON.parse(await readFile(`node_modules/${entry.package}/package.json`, 'utf8'));
  const manifest = /** @type {Manifest} */ (manifestJson);
  const contents = await Promise.all((entry.files ?? []).map((file) => readFile(file, 'utf8')));
  if (entry.repositoryFiles?.length) {
    for (const file of entry.repositoryFiles) {
      contents.push(await fetchText(repositoryFileUrl(manifest, file)));
    }
  }
  if (entry.url) {
    contents.push(await fetchText(entry.url));
  }
  const header = 'The following npm package may be included in this product:\n\n' +
    ` - ${manifest.name}@${manifest.version}\n\n` +
    'This package contains the following license:\n\n';
  await appendFile('dist/ThirdPartyNotices.txt', `\n\n${header}${contents.join('\n\n')}`, 'utf8');
}
