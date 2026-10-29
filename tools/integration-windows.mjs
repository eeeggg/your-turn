/**
 * The kinds of window integration tests run in, each named for the directory under `tests/integration` that holds its
 * tests. A kind exists only for a workspace shape the extension behaves differently in.
 * @type {readonly { name: string, directory: string, opensFolder: boolean }[]}
 */
export const windowKinds = [
  { name: 'empty', directory: '', opensFolder: false },
  { name: 'folder', directory: 'folder', opensFolder: true },
];
