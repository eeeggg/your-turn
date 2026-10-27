/** A file's content: its text, or `null` when nothing is at its path. */
export type FileContent = string | null;

/** A file whose net change is under review: what it held when the review first saw it change, and what it holds now. */
export interface ReviewedFile {
  readonly path: string;
  readonly baseline: FileContent;
  readonly current: FileContent;
}

/** What is at a path now: its text, or `null` when nothing is there; rejects when it cannot be read as text. */
export type ReadFile = (path: string) => Promise<FileContent>;

/** Puts `content` at `path`, `null` deleting what is there; rejects when it could not. */
export type RestoreFile = (path: string, content: FileContent) => Promise<void>;

/** A file came under review, changed, or left it. */
export type ReviewListener = (path: string) => void;

/**
 * One session's review: each file's net change from its baseline, whoever made it, in the order the files came under
 * review. Only a change reported as evidence puts a file under review; a file back at its
 * baseline leaves it, and is forgotten, so a later change starts a new baseline.
 */
export class Review {
  private readonly reviewed = new Map<string, ReviewedFile>();
  private readonly listeners = new Set<ReviewListener>();

  constructor(private readonly restore: RestoreFile) {}

  addListener(listener: ReviewListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: ReviewListener): void {
    this.listeners.delete(listener);
  }

  files(): readonly ReviewedFile[] {
    return [...this.reviewed.values()];
  }

  file(path: string): ReviewedFile | undefined {
    return this.reviewed.get(path);
  }

  /** Evidence that `path` held `before` and now holds `after`; the first for a path under review sets its baseline. */
  changed(path: string, before: FileContent, after: FileContent): void {
    this.set(path, this.reviewed.get(path)?.baseline ?? before, after);
  }

  /** What a file under review holds now, however it came to; a path not under review is not evidence. */
  read(path: string, content: FileContent): void {
    const file = this.reviewed.get(path);
    if (file) { this.set(path, file.baseline, content); }
  }

  /**
   * A baseline the review sets itself, a change kept or the user's edits taken in, rather than evidence. The file stays
   * under review until what it holds, its disk and not its unsaved edits, is the baseline.
   */
  setBaseline(path: string, baseline: FileContent): void {
    const file = this.reviewed.get(path);
    if (file) { this.set(path, baseline, file.current); }
  }

  keepFile(path: string): void {
    const file = this.reviewed.get(path);
    if (file) { this.set(path, file.current, file.current); }
  }

  keepAll(): void {
    for (const path of [...this.reviewed.keys()]) { this.keepFile(path); }
  }

  /** Restores the file's baseline; the file leaves the review only once that is done, and stays when it fails. */
  async undoFile(path: string): Promise<void> {
    const file = this.reviewed.get(path);
    if (!file) { return; }
    await this.restore(path, file.baseline);
    this.set(path, file.baseline, file.baseline);
  }

  private set(path: string, baseline: FileContent, current: FileContent): void {
    const file = this.reviewed.get(path);
    if (baseline === current) {
      if (!file) { return; }
      this.reviewed.delete(path);
    } else {
      if (file?.baseline === baseline && file.current === current) { return; }
      this.reviewed.set(path, { path, baseline, current });
    }
    for (const listener of this.listeners) { listener(path); }
  }
}
