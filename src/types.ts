import type { Stats } from "node:fs";

export type WatchEvent = "add" | "addDir" | "change" | "unlink" | "unlinkDir";

export type Ignored =
  | RegExp
  | string
  | ((path: string, stats?: Stats) => boolean)
  | readonly Ignored[];

export interface WatchOptions {
  /** Do not report what already exists when a path is watched. */
  ignoreInitial?: boolean;
  /** How many directory levels below a watched directory are descended into. Default: unlimited. */
  depth?: number;
  /**
   * Paths to skip. A skipped directory is not descended into. Receives absolute paths; a RegExp is tested against
   * the path with `/` as the separator. A function that declares two parameters (`length` 2 or more) is called once, with the
   * `fs.Stats` of the path (of the target, for a link); any other function is called with the path alone.
   */
  ignored?: Ignored;
  /**
   * Descend into directories that a symbolic link points at. A link back to a directory on its own path is
   * reported but not descended into. When false, a link is watched as itself and pointing it elsewhere is
   * reported as `change`. Default: true.
   */
  followSymlinks?: boolean;
  /**
   * Hold the unlink of a file that is deleted by itself back for this many ms (`true`: 100). A file created again at
   * the same path within that time is reported as one `change` instead of unlink and add, which is how editors that
   * save by deleting and creating the file look. The files below a removed directory and `unlinkDir` are reported at
   * once. Also skips the temporary files editors leave (`.swp`, `.swx`, a trailing `~`, Sublime's `.subl*.tmp`).
   * With false nothing is held back, and an add is still reported after the usual quiet period. Default: true.
   */
  atomic?: boolean | number;
  /**
   * With false, the watcher does not keep the process alive: the native watch handles and the internal timers are
   * unref'd, so a process that has nothing else to do exits without `close()`. Default: true.
   */
  persistent?: boolean;
  /**
   * A snapshot from `watcher.snapshot()`, taken in an earlier run. The initial scan then reports only what differs
   * from it (add, change, unlink, addDir, unlinkDir) before `ready`, whatever `ignoreInitial` says. `null`, or a
   * snapshot that is not usable (another version, malformed), is dropped, so everything is reported as add: pass
   * `null` on the first run.
   */
  since?: Snapshot | null;
  /**
   * Call `rescan()` this many ms after the previous one finished, from `ready` until `close()`, for file systems
   * where `fs.watch` reports nothing (NFS, Docker bind mounts, `/mnt/c` in WSL2). The wait starts when a read is
   * done, so a slow tree is not read back to back. With `persistent: false` the timer is unref'd. 0 or unset: no
   * timer, and `rescan()` is yours to call. Default: 0.
   */
  rescanInterval?: number;
  /** Skip EACCES and EPERM silently instead of emitting `error`. Default: false. */
  ignorePermissionErrors?: boolean;
  /** Hold add / change back until the file's size and mtime have been stable for `stabilityThreshold` ms. */
  awaitWriteFinish?: boolean | { stabilityThreshold?: number; pollInterval?: number };
}

/** What `snapshot()` records of one path. Absolute, with the platform's separator, as events report it. */
export interface SnapshotEntry {
  path: string;
  dir: boolean;
  mtimeMs: number;
  size: number;
  ino: number;
  /** Where a link points when it is watched as itself; for a directory, its real path. */
  link?: string;
}

/** JSON-serializable state of a watcher. Pass it back as `since` to learn what changed in between. */
export interface Snapshot {
  version: 1;
  entries: SnapshotEntry[];
}

export interface ReadyResult {
  /** Absolute paths, in the order given, that did not exist when watching started. They are watched once they appear. */
  missing: string[];
}

export interface Events {
  add: [path: string];
  addDir: [path: string];
  change: [path: string];
  unlink: [path: string];
  unlinkDir: [path: string];
  all: [event: WatchEvent, path: string];
  ready: [result: ReadyResult];
  error: [error: Error];
}

export interface Entry {
  dir: boolean;
  mtimeMs: number;
  size: number;
  ino: number;
  /** Where a link points when it is watched as itself; for a directory, its real path. */
  link?: string;
}

export interface Settling {
  event: "add" | "change";
  /** What was reported last, for a change that is still waiting: that is what `snapshot()` records. */
  before?: Entry;
  timer?: NodeJS.Timeout;
}
