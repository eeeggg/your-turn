# Change management and releases

This document defines the project's branch, versioning, and release policy.

## Branches and contributions

- `master` integrates accepted contributions and receives release preparations.
  Contribution branches open pull requests against `master`.
- `master` requires pull requests and the `Checks`, `Unit`, `Webview`, `Integration`,
  and `Desktop UI` checks. Force pushes and branch deletion are blocked,
  including for maintainers.
- Either maintainer can merge contributions. Maintainers do not require each
  other's approval for their own pull requests; no approving review count is
  required. Outside contributors do not have merge access.
- Workflow runs from outside collaborators require maintainer approval.

## Versions

The tracked version in `package.json` and `package-lock.json` is the intended
release or Marketplace pre-release version. Both must agree. The first public release is 0.4.0 and is
described as beta; that label does not establish a Marketplace pre-release
channel.

Change versions deliberately during release planning, not for every contribution.
Use npm's version operation rather than editing the manifest and running an
install to synchronize the lockfile. For example, when authorized:

```sh
npm version 0.4.1 --no-git-tag-version
```

This updates the version metadata without creating a commit or tag. Review the
diff and include it in a pull request. Dependency changes are separate work;
`npm ci` installs the locked graph, and an extension version change does not
require `npm install`.

Use even minor versions for regular-channel releases and odd minor versions
for Marketplace pre-releases, following Microsoft's extension publishing
guidance. The initial regular release line is `0.4.x`, the next pre-release
line is `0.5.x`, and its regular successor is `0.6.x`. Patch numbers advance
within each line. This convention reserves minor-version parity for channels,
rather than applying strict semantic versioning to minor increments.
Document breaking changes explicitly, even before 1.0. Never reuse a published
version for different package contents.

Version and channel are explicit inputs to candidate preparation. Marketplace
requires numeric `major.minor.patch` versions; a pre-release candidate must be
packaged with the Marketplace pre-release flag before acceptance testing.
Moving accepted work from a pre-release to the regular channel requires a new
version and package, not relabeling or republishing the same candidate.

A higher regular version can update installations opted into pre-releases;
those installations remain eligible for later pre-releases. Allocate versions
with this ordering in mind, including regular-line hotfixes while a higher
pre-release line is active.

After a release, continue development on `master` for the next intended version.

## Development builds

CI runs `Checks` independently and in parallel with the four test suites.
`Checks` runs TypeScript, ESLint, Knip, and pinned actionlint workflow validation.
The suites use explicit test-only npm commands while retaining their own build,
editor preparation, and cleanup. Packaging requires all five jobs to succeed.

Successful pushes to `master` produce development VSIX artifacts after all four
test suites and `Checks` pass. They are optional test builds, not published
releases, and expire according to Actions artifact retention. Installation is
never automatic.

Development packaging assigns a unique version only in CI's disposable
checkout, updating both manifests through npm. The version format is
`<target>-dev.<run>.<attempt>`. Each artifact must
identify its full source commit and CI run, including the attempt, so it can be
traced back to the code tested. Do not commit CI-generated versions back to `master`.

Development builds are distributed only as Actions artifacts. They are not
Marketplace pre-releases. Selected `master` commits can become Marketplace
pre-release candidates through explicit version/channel preparation and the
same candidate verification and authorized publication process below.

## Release candidates

1. Settle the release scope, version, and user-facing entry in
   [CHANGELOG.md](CHANGELOG.md), including the release date before publication.
2. Open a release pull request into `master`. All five required CI checks
   must pass. Either maintainer can accept the release preparation.
3. After merging, manually trigger the CI workflow dispatch on `master` to package
   the exact commit as a release candidate. Its artifact identifies the source commit
   and CI run. A successful build does not publish anything.
   For a Marketplace pre-release, prepare an odd-minor numeric version through
   a pull request into `master`, then explicitly build a pre-release candidate
   from that accepted commit. The automatic development artifact is not a substitute
   for this channel-specific package.
4. Verify the candidate's embedded version, changelog, license, notices, and
   recipient-accessible corresponding source. Complete applicable manual
   real-agent, Remote-SSH installation, and qualitative checks described in
   [tests/AGENTS.md](tests/AGENTS.md). Installation requires authorization.
5. If changes are needed, make them through pull requests and build a new
   candidate. Publication must name the approved candidate, not merely the
   latest successful run.

Do not overlap local packaging and test builds. Use the supported test
preparation workflow after packaging clears development bundles.

## Publication

### Changelog entries

Every published version has a dated entry in `CHANGELOG.md`. Label odd-minor
Marketplace publications as **Pre-release**. The next even-minor regular
release summarizes changes since the previous regular release, including work
introduced in intervening pre-releases. Retain those pre-release entries as
history. Ordinary CI development artifacts do not receive changelog entries.

### Publishing an approved candidate

Publication is a separate, explicitly authorized operation:

1. Record the approved VSIX's source commit, version, CI run and attempt, and
   SHA-256 checksum. Preserve the approved artifact before its Actions retention
   expires; do not silently substitute a rebuild.
2. Create the matching `v<version>` tag on that exact source commit, verifying
   that the tag and both manifests agree. Do not move a published release tag.
3. Create the GitHub Release with the corresponding changelog section and
   attach the approved version-specific VSIX. Identify the release as beta
   while the project is in beta.
4. Publish the same approved VSIX bytes to the Visual Studio Marketplace;
   do not rebuild or increment the version as part of uploading it.
   Use the channel selected when the candidate was packaged. Mark GitHub
   releases for Marketplace pre-release candidates as pre-releases; the
   project's beta maturity label alone does not require that channel.
5. Verify the GitHub download, source mapping, and Marketplace version. Record
   any partial publication failure and finish the missing destination using
   the same artifact rather than generating different contents for that version.

No publishing framework, automatic commit-message version selection, or
merge-triggered publication is required. Creating branches, changing repository
settings or visibility, version changes, packaging, installation, commits,
tags, pushes, and publication each remain subject to explicit authorization.
