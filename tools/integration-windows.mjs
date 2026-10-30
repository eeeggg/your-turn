/**
 * The kinds of window integration tests run in, each named for the directory under `tests/integration` that holds its
 * tests. A kind exists only for a workspace shape the extension behaves differently in. Each job's window opens
 * `folders` fresh folders: as they are, which for more than one makes an unsaved workspace, or `saved` in a
 * `.code-workspace` file the runner writes.
 * @type {readonly { name: string, directory: string, folders: number, saved: boolean }[]}
 */
export const windowKinds = [
  { name: 'folder', directory: '', folders: 1, saved: false },
  { name: 'empty', directory: 'empty', folders: 0, saved: false },
  { name: 'untitled-workspace', directory: 'untitled-workspace', folders: 2, saved: false },
  { name: 'saved-workspace', directory: 'saved-workspace', folders: 2, saved: true },
];
