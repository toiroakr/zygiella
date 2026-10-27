import { EventEmitter } from "node:events";
import { watch as nativeWatch, type FSWatcher as NativeWatcher, type Stats } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

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

interface Events {
  add: [path: string];
  addDir: [path: string];
  change: [path: string];
  unlink: [path: string];
  unlinkDir: [path: string];
  all: [event: WatchEvent, path: string];
  ready: [result: ReadyResult];
  error: [error: Error];
}

interface Entry {
  dir: boolean;
  mtimeMs: number;
  size: number;
  ino: number;
  /** Where a link points when it is watched as itself; for a directory, its real path. */
  link?: string;
}

interface Settling {
  event: "add" | "change";
  /** What was reported last, for a change that is still waiting: that is what `snapshot()` records. */
  before?: Entry;
  timer?: NodeJS.Timeout;
}

const SNAPSHOT_VERSION = 1;
const QUIET_MS = 50;
const READY_SETTLE_MS = 50;
const ATOMIC_MS = 100;
// setTimeout treats a delay above 2 ** 31 - 1 as 1 ms
const MAX_TIMER_MS = 2 ** 31 - 1;
const EDITOR_TEMP = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;

/**
 * quiet: remember only. initial: report at once (it is what `ready` waits for). seed: initial against a snapshot, so
 * `change` and `unlink` come at once too. live: report once the burst of events is over.
 */
type Mode = "quiet" | "initial" | "seed" | "live";

const VANISHED = new Set(["ENOENT", "ENOTDIR"]);
const DENIED = new Set(["EACCES", "EPERM"]);

const within = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

interface Matcher {
  byPath: (path: string) => boolean;
  /** Present only when some function asked for stats. */
  byStats?: (path: string, stats: Stats) => boolean;
}

const slashed = sep === "/" ? (path: string) => path : (path: string) => path.split(sep).join("/");

function matcher(ignored: Ignored | undefined): Matcher {
  if (ignored === undefined) return { byPath: () => false };
  if (typeof ignored === "function")
    return ignored.length >= 2
      ? { byPath: () => false, byStats: (path, stats) => ignored(path, stats) }
      : { byPath: (path) => ignored(path) };
  if (ignored instanceof RegExp)
    return {
      byPath: (path) => {
        // with the g or y flag, test() resumes from the last match, so a second path would not be tested from its start
        ignored.lastIndex = 0;
        return ignored.test(slashed(path));
      },
    };
  if (typeof ignored === "string") {
    const target = resolve(ignored);
    return { byPath: (path) => within(target, path) };
  }
  const all = ignored.map(matcher);
  const withStats = all.filter((m) => m.byStats);
  return {
    byPath: (path) => all.some((m) => m.byPath(path)),
    byStats: withStats.length
      ? (path, stats) => withStats.some((m) => m.byStats!(path, stats))
      : undefined,
  };
}

const isSnapshotEntry = (entry: unknown): entry is SnapshotEntry => {
  const e = entry as Partial<Record<keyof SnapshotEntry, unknown>> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.path === "string" &&
    typeof e.dir === "boolean" &&
    typeof e.mtimeMs === "number" &&
    typeof e.size === "number" &&
    typeof e.ino === "number" &&
    (e.link === undefined || typeof e.link === "string")
  );
};

const list = (paths: string | readonly string[]): string[] =>
  (typeof paths === "string" ? [paths] : [...paths]).map((p) => resolve(p));

export class FSWatcher extends EventEmitter<Events> {
  readonly #ignored: Matcher;
  readonly #atomic: number;
  readonly #ignoreInitial: boolean;
  readonly #depth: number;
  readonly #followSymlinks: boolean;
  readonly #ignorePermissionErrors: boolean;
  readonly #persistent: boolean;
  readonly #rescanInterval: number;
  readonly #settle: { stabilityThreshold: number; pollInterval: number } | undefined;

  readonly #roots = new Set<string>();
  readonly #kinds = new Map<string, "dir" | "file" | "missing">();
  readonly #probes = new Map<string, string>();
  readonly #entries = new Map<string, Entry>();
  readonly #children = new Map<string, Set<string>>();
  readonly #depthLeft = new Map<string, number>();
  /** Real paths of the directories from the watched root down to each directory, the directory's own last. */
  readonly #ancestry = new Map<string, readonly string[]>();
  readonly #native = new Map<string, NativeWatcher>();
  readonly #queues = new Map<string, { dirty: boolean; done: Promise<void> }>();
  readonly #settling = new Map<string, Settling>();
  /** An unlink held back for `atomic`: it is not reported yet, so `entry` is still what was last reported. */
  readonly #unlinks = new Map<string, { timer: NodeJS.Timeout; entry: Entry }>();
  readonly #denied = new Set<string>();
  readonly #unwatched = new Set<string>();
  readonly #missingAtStart = new Set<string>();
  #rescanTimer: NodeJS.Timeout | undefined;
  #closed = false;

  #ready: Promise<ReadyResult>;

  /**
   * Resolves once the paths last given to `watch()` or `add()` are being watched, so a change made right after it
   * is reported. It resolves to the paths of that call that did not exist. The `ready` event is emitted for the
   * paths given to `watch()` only.
   */
  get ready(): Promise<ReadyResult> {
    return this.#ready;
  }

  /**
   * Directories that are read but have no native watch, because `fs.watch` threw (`ENOSPC`, `EMFILE`) or the
   * watcher reported an error. Changes below them are missed until `rescan()` reads them, and it also tries to
   * watch them again.
   */
  get unwatched(): readonly string[] {
    return [...this.#unwatched].sort();
  }

  constructor(paths: string | readonly string[], options: WatchOptions = {}) {
    super();
    const atomic = options.atomic ?? true;
    this.#atomic = atomic === true ? ATOMIC_MS : atomic || 0;
    const userIgnored = matcher(options.ignored);
    this.#ignored =
      this.#atomic > 0
        ? { ...userIgnored, byPath: (path) => EDITOR_TEMP.test(path) || userIgnored.byPath(path) }
        : userIgnored;
    this.#ignoreInitial = options.ignoreInitial ?? false;
    this.#depth = options.depth ?? Infinity;
    this.#followSymlinks = options.followSymlinks ?? true;
    this.#ignorePermissionErrors = options.ignorePermissionErrors ?? false;
    this.#persistent = options.persistent ?? true;
    const rescanInterval = options.rescanInterval ?? 0;
    // `false` and `""` would pass the range test by coercion, and setTimeout reads them as 1 ms
    if (
      typeof rescanInterval !== "number" ||
      !(rescanInterval >= 0 && rescanInterval <= MAX_TIMER_MS)
    )
      throw new RangeError(
        `rescanInterval must be a number from 0 to ${MAX_TIMER_MS} ms, got ${String(rescanInterval)}`,
      );
    this.#rescanInterval = rescanInterval;
    const awf = options.awaitWriteFinish;
    this.#settle = awf
      ? {
          stabilityThreshold: (typeof awf === "object" && awf.stabilityThreshold) || 2000,
          pollInterval: (typeof awf === "object" && awf.pollInterval) || 100,
        }
      : undefined;
    const roots = list(paths);
    this.#seed(options.since, roots);
    this.#ready = this.#watch(roots, options.since !== undefined).then((result) => {
      if (!this.#closed) this.emit("ready", result);
      this.#scheduleRescan();
      return result;
    });
  }

  /**
   * The state to start the next run from (`since`): what has been reported so far. A file whose `add` is still
   * waiting is left out, so the next run reports it; a `change` that is waiting, or an `unlink` held back for
   * `atomic`, is recorded as it was before, so the next run reports that too.
   */
  snapshot(): Snapshot {
    const entries: SnapshotEntry[] = [];
    for (const [path, current] of this.#entries) {
      const job = this.#settling.get(path);
      if (job && !job.before) continue;
      const { dir, mtimeMs, size, ino, link } = job?.before ?? current;
      entries.push(
        link === undefined
          ? { path, dir, mtimeMs, size, ino }
          : { path, dir, mtimeMs, size, ino, link },
      );
    }
    for (const [path, { entry }] of this.#unlinks) entries.push({ path, ...entry });
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { version: SNAPSHOT_VERSION, entries };
  }

  /** Remembers what `since` holds for the watched roots, so the first scan reports only the difference. */
  #seed(since: Snapshot | null | undefined, roots: string[]): void {
    if (!since || since.version !== SNAPSHOT_VERSION || !Array.isArray(since.entries)) return;
    const kept = new Set<string>();
    // shallow first, so that whether the parent was kept is known
    const usable = since.entries
      .filter(isSnapshotEntry)
      .sort((x, y) => x.path.length - y.path.length);
    for (const entry of usable) {
      const root = roots
        .filter((r) => within(r, entry.path))
        .sort((a, b) => b.length - a.length)[0];
      if (root === undefined) continue;
      // below the levels that are descended into now, so it is not scanned and would be reported as unlink
      if (entry.path.slice(root.length).split(sep).filter(Boolean).length > this.#depth + 1)
        continue;
      // an ignored path, or one below an ignored directory, is not scanned: it would be reported as unlink
      let skipped = false;
      for (let path = entry.path; !skipped; path = dirname(path)) {
        skipped = this.#ignored.byPath(path);
        if (roots.includes(path) || dirname(path) === path) break;
      }
      if (skipped) continue;
      // below an entry that is missing, it can never be reached from its parent, and would stay in the baseline
      if (!roots.includes(entry.path) && !kept.has(dirname(entry.path))) continue;
      if (entry.dir) kept.add(entry.path);
      const { dir, mtimeMs, size, ino, link } = entry;
      this.#setEntry(entry.path, { dir, mtimeMs, size, ino, link });
    }
  }

  add(paths: string | readonly string[]): this {
    this.#ready = this.#watch(list(paths));
    return this;
  }

  unwatch(paths: string | readonly string[]): this {
    for (const path of list(paths)) {
      this.#roots.delete(path);
      this.#missingAtStart.delete(path);
      for (const key of this.#denied) if (within(path, key)) this.#denied.delete(key);
      this.#kinds.delete(path);
      const probe = this.#probes.get(path);
      this.#probes.delete(path);
      this.#remove(path, false, (key) => ![...this.#roots].some((root) => within(root, key)));
      if (probe) this.#release(probe);
      // a directory whose watch failed has no entry, so #remove never released it
      for (const key of this.#unwatched) if (within(path, key)) this.#release(key);
      const parent = dirname(path);
      if (parent !== path) this.#release(parent);
    }
    return this;
  }

  /**
   * Reads every watched root and every directory descended into again, and reports what differs from the last
   * time. Resolves once that is read; add / change are reported after their usual wait.
   */
  async rescan(): Promise<void> {
    if (this.#closed) return;
    // a call made while a rescan runs makes it run once more afterwards, so two rescans never read at the same time
    await this.#serial("rescan", () => this.#rescanOnce());
  }

  async #rescanOnce(): Promise<void> {
    await Promise.all(
      [...this.#roots].map((root) =>
        this.#serial(`root:${root}`, () => this.#syncRoot(root, "live")),
      ),
    );
    // a read can drop a directory or change what lies below it, so shallow directories go first and each one is
    // looked up again when its turn comes
    const levels = new Map<number, string[]>();
    for (const dir of this.#depthLeft.keys()) {
      const depth = dir.split(sep).length;
      const level = levels.get(depth);
      if (level) level.push(dir);
      else levels.set(depth, [dir]);
    }
    for (const depth of [...levels.keys()].sort((a, b) => a - b)) {
      await Promise.all(
        levels.get(depth)!.map((dir) => {
          const left = this.#depthLeft.get(dir);
          const ancestry = this.#ancestry.get(dir);
          return left !== undefined && ancestry && !this.#roots.has(dir)
            ? this.#serial(`dir:${dir}`, () => this.#syncDir(dir, left, "live", ancestry))
            : undefined;
        }),
      );
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#rescanTimer);
    // what was never reported is not what the snapshot should say the watcher saw
    for (const [path, job] of this.#settling) {
      clearTimeout(job.timer);
      if (job.before) this.#entries.set(path, job.before);
      else this.#entries.delete(path);
    }
    this.#settling.clear();
    for (const [path, { timer, entry }] of this.#unlinks) {
      clearTimeout(timer);
      this.#entries.set(path, entry);
    }
    this.#unlinks.clear();
    for (const watcher of this.#native.values()) watcher.close();
    this.#native.clear();
    this.#unwatched.clear();
    await Promise.all([...this.#queues.values()].map((q) => q.done));
  }

  #scheduleRescan(): void {
    if (this.#closed || this.#rescanInterval === 0) return;
    this.#rescanTimer = this.#timeout(() => {
      void this.rescan().finally(() => this.#scheduleRescan());
    }, this.#rescanInterval);
  }

  #timeout(fn: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(fn, ms);
    if (!this.#persistent) timer.unref();
    return timer;
  }

  async #watch(roots: string[], since = false): Promise<ReadyResult> {
    await this.#start(roots, since ? "seed" : this.#ignoreInitial ? "quiet" : "initial");
    const missing = [...new Set(roots)].filter((root) => this.#missingAtStart.has(root));
    // not unref'd: a caller awaiting `ready` would otherwise see the process exit before it resolves (exit code 13)
    // fs.watch returns before the OS starts delivering (FSEvents on macOS): a change made in that gap is never reported
    await new Promise<void>((done) => setTimeout(done, READY_SETTLE_MS));
    return { missing };
  }

  #start(roots: string[], mode: Mode): Promise<void> {
    for (const root of roots) this.#roots.add(root);
    return Promise.all(
      roots.map((root) => this.#serial(`root:${root}`, () => this.#syncRoot(root, mode))),
    ).then(() => undefined);
  }

  /** Runs `fn` for `key` one at a time; a request made while it runs makes it run once more afterwards. */
  #serial(key: string, fn: () => Promise<void>): Promise<void> {
    const running = this.#queues.get(key);
    if (running) {
      running.dirty = true;
      return running.done;
    }
    const queue = { dirty: false, done: Promise.resolve() };
    this.#queues.set(key, queue);
    queue.done = (async () => {
      try {
        do {
          queue.dirty = false;
          await fn().catch((error: NodeJS.ErrnoException) => this.#fail(error, key));
        } while (queue.dirty && !this.#closed);
      } finally {
        this.#queues.delete(key);
      }
    })();
    return queue.done;
  }

  async #syncRoot(root: string, mode: Mode): Promise<void> {
    if (this.#closed || !this.#roots.has(root)) return;
    if (this.#ignored.byPath(root)) return;
    const previousProbe = this.#probes.get(root);
    const previousParent = this.#kinds.get(root) === "file" ? dirname(root) : undefined;
    if (mode !== "live") this.#missingAtStart.delete(root);
    let unreadable = false;
    let info = await this.#stat(root).catch((error: NodeJS.ErrnoException) => {
      this.#fail(error, root);
      unreadable = !VANISHED.has(error.code ?? "");
      if (mode !== "live" && VANISHED.has(error.code ?? "")) this.#missingAtStart.add(root);
      return undefined;
    });
    let link: string | undefined;
    if (!this.#followSymlinks && info?.isSymbolicLink()) {
      link = await readlink(root).catch(() => undefined);
      if (link === undefined) info = undefined;
    }
    if (this.#closed || !this.#roots.has(root)) return;
    if (info && !info.isDirectory()) this.#denied.delete(root);

    if (!info) {
      // a root that cannot be inspected is not known to be gone, and neither is what is below it
      if (!unreadable) this.#remove(root, true, undefined, mode !== "seed");
      this.#kinds.set(root, "missing");
      const nearest = async (): Promise<string> => {
        let ancestor = dirname(root);
        while (
          !(await stat(ancestor).catch(() => undefined))?.isDirectory() &&
          dirname(ancestor) !== ancestor
        )
          ancestor = dirname(ancestor);
        return ancestor;
      };
      // a deeper folder may be created while the watcher is being attached, and would then never be seen
      let ancestor = await nearest();
      const attached = new Set<string>();
      for (;;) {
        this.#probes.set(root, ancestor);
        this.#ensureNative(ancestor);
        attached.add(ancestor);
        const again = await nearest();
        if (again === ancestor) break;
        ancestor = again;
      }
      if (previousProbe) attached.add(previousProbe);
      attached.delete(ancestor);
      for (const stale of attached) this.#release(stale);
      if (previousParent) this.#release(previousParent);
      // the root may have been created between the stat above and the watch being attached
      if (
        await this.#stat(root).then(
          () => true,
          () => false,
        )
      )
        await this.#syncRoot(root, "live");
      return;
    }

    if (!this.#entries.has(root) && this.#ignored.byStats?.(root, info)) {
      // watched all the same, so that the path is read again when its stats may have changed
      this.#kinds.set(root, info.isDirectory() ? "dir" : "file");
      // a directory has no entry to keep its watch while it is skipped, so the probe does, and unwatch() releases it
      if (info.isDirectory()) this.#probes.set(root, root);
      else this.#probes.delete(root);
      this.#ensureNative(info.isDirectory() ? root : dirname(root));
      if (previousProbe) this.#release(previousProbe);
      if (previousParent) this.#release(previousParent);
      return;
    }
    this.#probes.delete(root);
    if (info.isDirectory()) {
      this.#kinds.set(root, "dir");
      this.#ensureNative(root);
      const real = await realpath(root).catch(() => root);
      await this.#visit(root, info, 0, mode, [], real);
      await this.#syncDir(root, this.#depth, mode, [real]);
    } else {
      this.#kinds.set(root, "file");
      this.#ensureNative(dirname(root));
      await this.#visit(root, info, 0, mode, [], link);
    }
    if (previousProbe) this.#release(previousProbe);
    if (previousParent) this.#release(previousParent);
  }

  /**
   * Forgets what a snapshot put below a link back to an ancestor, which is never descended into: nothing would scan
   * it, so it would stay in the baseline after the file is gone. What a watched root at or below that path covers is
   * scanned through that root and keeps its entries, and so do the directories between that path and the root.
   */
  #forgetBelow(path: string): void {
    if (!this.#children.get(path)?.size) return;
    this.#remove(
      path,
      false,
      (key) =>
        key !== path &&
        ![...this.#roots].some(
          (root) => within(path, root) && (within(root, key) || within(key, root)),
        ),
    );
  }

  #stat(path: string): Promise<Stats> {
    return this.#followSymlinks ? stat(path) : lstat(path);
  }

  async #syncDir(
    dir: string,
    left: number,
    mode: Mode,
    ancestry: readonly string[],
  ): Promise<void> {
    if (this.#closed || ![...this.#roots].some((root) => within(root, dir))) return;
    // attach the watcher before reading, so nothing that changes during the scan is lost
    this.#depthLeft.set(dir, left);
    this.#ancestry.set(dir, ancestry);
    this.#ensureNative(dir);
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      this.#fail(error, dir);
      return undefined;
    });
    if (!names || this.#closed) return;
    this.#denied.delete(dir);

    const seen = new Set<string>();
    const uninspectable = new Set<string>();
    const inspectFailed = (error: NodeJS.ErrnoException, path: string): undefined => {
      this.#fail(error, path);
      if (!VANISHED.has(error.code ?? "")) uninspectable.add(path);
      return undefined;
    };
    await Promise.all(
      names.map(async (name) => {
        const path = join(dir, name);
        if (this.#ignored.byPath(path)) return;
        const own = await lstat(path).catch((error) => inspectFailed(error, path));
        if (!own) return;
        let info = own;
        let real = join(ancestry.at(-1)!, name);
        let link: string | undefined;
        let descend = left;
        if (own.isSymbolicLink()) {
          if (this.#followSymlinks) {
            const target = await stat(path).catch((error) => inspectFailed(error, path));
            if (!target) return;
            info = target;
            if (target.isDirectory()) {
              const resolved = await realpath(path).catch((error) => inspectFailed(error, path));
              if (!resolved) return;
              real = resolved;
              // a link to a directory already on the way down would loop forever
              if (ancestry.includes(real)) {
                descend = 0;
                // a link that points somewhere else than before is reported by #visit, with what was below it
                if (mode === "seed" && this.#entries.get(path)?.link === real)
                  this.#forgetBelow(path);
              }
            }
          } else {
            link = await readlink(path).catch((error) => inspectFailed(error, path));
            if (link === undefined) return;
          }
        }
        if (own.isSymbolicLink() || !info.isDirectory()) this.#denied.delete(path);
        if (!this.#entries.has(path) && this.#ignored.byStats?.(path, info)) return;
        seen.add(path);
        await this.#visit(
          path,
          info,
          descend,
          mode,
          [...ancestry, real],
          info.isDirectory() ? real : link,
        );
      }),
    );
    if (this.#closed) return;
    for (const path of this.#children.get(dir) ?? []) {
      if (!seen.has(path) && !uninspectable.has(path) && !this.#roots.has(path))
        this.#remove(path, true, undefined, mode !== "seed");
    }
    const listed = new Set(names);
    for (const path of this.#denied) {
      if (dirname(path) === dir && !listed.has(basename(path))) this.#denied.delete(path);
    }
  }

  async #visit(
    path: string,
    info: Stats,
    left: number,
    mode: Mode,
    ancestry: readonly string[] = [],
    link?: string,
  ): Promise<void> {
    // a scan that was reading when close() was called must not add what was never reported to the baseline
    if (this.#closed) return;
    const next: Entry = {
      dir: info.isDirectory(),
      mtimeMs: info.mtimeMs,
      size: info.size,
      ino: info.ino,
      link,
    };
    let previous = this.#entries.get(path);
    if (previous && (previous.dir !== next.dir || (next.dir && previous.link !== next.link))) {
      this.#remove(path, true);
      previous = undefined;
    }
    if (!previous) {
      if (next.dir) this.#flushUnlink(path);
      // an unlink listener may have closed the watcher: the entry would be in the baseline without being reported
      if (this.#closed) return;
      this.#setEntry(path, next);
      if (next.dir) {
        if (mode !== "quiet") this.#dispatch("addDir", path);
      } else if (mode === "live" || this.#unlinks.has(path)) this.#announce("add", path);
      else if (mode !== "quiet") this.#dispatch("add", path);
      if (next.dir && left > 0) await this.#syncDir(path, left - 1, mode, ancestry);
      return;
    }
    // a directory remembered from a snapshot has not been read yet
    if (next.dir && left > 0 && !this.#depthLeft.has(path))
      await this.#syncDir(path, left - 1, mode, ancestry);
    if (
      !next.dir &&
      (previous.mtimeMs !== next.mtimeMs ||
        previous.size !== next.size ||
        previous.ino !== next.ino ||
        previous.link !== next.link)
    ) {
      this.#setEntry(path, next);
      if (mode === "seed") this.#dispatch("change", path);
      else if (mode !== "quiet") this.#announce("change", path, previous);
    }
  }

  #setEntry(path: string, entry: Entry): void {
    this.#entries.set(path, entry);
    const parent = dirname(path);
    let siblings = this.#children.get(parent);
    if (!siblings) this.#children.set(parent, (siblings = new Set()));
    siblings.add(path);
  }

  /**
   * Forgets `path` and everything below it, deepest first, optionally reporting each as unlink / unlinkDir.
   * With `defer`, the unlink of `path` itself is held back for the `atomic` window if it is a file.
   */
  #remove(
    path: string,
    report: boolean,
    only: (key: string) => boolean = () => true,
    defer = false,
  ): void {
    for (const [key, { timer }] of this.#unlinks) {
      if (!within(path, key) || !only(key) || (report && key === path)) continue;
      clearTimeout(timer);
      this.#unlinks.delete(key);
      // what is below a directory that goes away is reported before the directory is
      if (report) this.#dispatch("unlink", key);
    }
    const keys = [...this.#entries.keys()].filter((key) => within(path, key) && only(key));
    keys.sort((a, b) => b.length - a.length);
    for (const key of keys) {
      // a listener closed the watcher: what is left was not reported, so it stays for the snapshot
      if (this.#closed) break;
      const entry = this.#entries.get(key)!;
      const job = this.#settling.get(key);
      clearTimeout(job?.timer);
      this.#settling.delete(key);
      this.#entries.delete(key);
      this.#denied.delete(key);
      this.#children.get(dirname(key))?.delete(key);
      this.#children.delete(key);
      if (entry.dir) {
        this.#depthLeft.delete(key);
        this.#ancestry.delete(key);
        this.#release(key);
      }
      // an add that never settled was never reported, so there is nothing to take back
      if (!report || job?.event === "add") continue;
      if (entry.dir) this.#dispatch("unlinkDir", key);
      else if (defer && this.#atomic > 0 && key === path)
        this.#holdUnlink(key, job?.before ?? entry);
      else this.#dispatch("unlink", key);
    }
  }

  #dispatch(event: WatchEvent, path: string): void {
    if (this.#closed) return;
    // `emit` forwards the arguments as given, and the events map types them per event
    (this.emit as (event: string, ...args: unknown[]) => boolean)(event, path);
    if (!this.#closed) this.emit("all", event, path);
  }

  #takeHeld(path: string): Entry | undefined {
    const held = this.#unlinks.get(path);
    if (!held) return undefined;
    clearTimeout(held.timer);
    this.#unlinks.delete(path);
    return held.entry;
  }

  #flushUnlink(path: string): void {
    if (this.#takeHeld(path)) this.#dispatch("unlink", path);
  }

  #holdUnlink(path: string, entry: Entry): void {
    const timer = this.#timeout(() => {
      this.#unlinks.delete(path);
      this.#dispatch("unlink", path);
    }, this.#atomic);
    this.#unlinks.set(path, { timer, entry });
  }

  #announce(event: "add" | "change", path: string, before?: Entry): void {
    const held = this.#takeHeld(path);
    if (held) event = "change";
    const settle = this.#settle;
    const prior = this.#settling.get(path);
    clearTimeout(prior?.timer);
    const job: Settling = {
      event: prior?.event === "add" ? "add" : event,
      before: prior ? prior.before : (before ?? held),
    };
    this.#settling.set(path, job);
    if (!settle) {
      // Linux reports a write as truncate then write, and a new file as create then write: one report for the burst
      job.timer = this.#timeout(() => {
        this.#settling.delete(path);
        this.#dispatch(job.event, path);
      }, QUIET_MS);
      return;
    }
    let last: string | undefined;
    let since = Date.now();
    const poll = async (): Promise<void> => {
      const info = await this.#stat(path).catch(() => undefined);
      const link =
        !this.#followSymlinks && info?.isSymbolicLink()
          ? await readlink(path).catch(() => undefined)
          : undefined;
      if (this.#settling.get(path) !== job) return;
      // gone: the directory diff reports the unlink, and needs this job to know whether the add was ever announced
      if (!info) return;
      const key = `${info.size}:${info.mtimeMs}`;
      if (key !== last) {
        last = key;
        since = Date.now();
      } else if (Date.now() - since >= settle.stabilityThreshold) {
        this.#settling.delete(path);
        // the file may have been written again since the entry was read, with no native event to read it again
        const entry = this.#entries.get(path);
        if (entry && !entry.dir)
          this.#entries.set(path, {
            ...entry,
            mtimeMs: info.mtimeMs,
            size: info.size,
            ino: info.ino,
            link: info.isSymbolicLink() ? (link ?? entry.link) : undefined,
          });
        this.#dispatch(job.event, path);
        return;
      }
      job.timer = this.#timeout(poll, settle.pollInterval);
    };
    job.timer = this.#timeout(poll, settle.pollInterval);
  }

  #ensureNative(dir: string): void {
    if (this.#closed || this.#native.has(dir)) return;
    try {
      const watcher = nativeWatch(dir, { persistent: this.#persistent });
      watcher.on("change", () => this.#onNative(dir));
      watcher.on("error", (error) => {
        // the directory itself went away; its parent's or the root's own sync reports it
        this.#native.delete(dir);
        watcher.close();
        this.#unwatch(dir, error);
        this.#onNative(dir);
      });
      this.#native.set(dir, watcher);
      this.#unwatched.delete(dir);
    } catch (error) {
      this.#unwatch(dir, error as NodeJS.ErrnoException);
    }
  }

  /** A directory that vanished is not listed: whoever removed it is reported by its parent's sync, which releases it. */
  #unwatch(dir: string, error: NodeJS.ErrnoException): void {
    if (!VANISHED.has(error.code ?? "")) this.#unwatched.add(dir);
    this.#fail(error, dir);
  }

  /** A path that vanished is a race with whoever removed it. A permission error is reported once per path until the path reads again. */
  #fail(error: NodeJS.ErrnoException, path: string): void {
    const code = error.code ?? "";
    if (this.#closed || VANISHED.has(code)) return;
    if (DENIED.has(code)) {
      if (this.#ignorePermissionErrors || this.#denied.has(path)) return;
      this.#denied.add(path);
    }
    this.emit("error", error);
  }

  #release(dir: string): void {
    const needed =
      this.#depthLeft.has(dir) ||
      [...this.#probes.values()].includes(dir) ||
      [...this.#roots].some((root) => this.#kinds.get(root) === "file" && dirname(root) === dir);
    if (needed) return;
    this.#unwatched.delete(dir);
    this.#native.get(dir)?.close();
    this.#native.delete(dir);
  }

  #onNative(dir: string): void {
    if (this.#closed) return;
    for (const root of this.#roots) {
      const kind = this.#kinds.get(root);
      const affected =
        kind === "dir"
          ? root === dir
          : kind === "file"
            ? dirname(root) === dir
            : this.#probes.get(root) === dir;
      if (affected) void this.#serial(`root:${root}`, () => this.#syncRoot(root, "live"));
    }
    const left = this.#depthLeft.get(dir);
    const ancestry = this.#ancestry.get(dir);
    if (left !== undefined && ancestry && !this.#roots.has(dir))
      void this.#serial(`dir:${dir}`, () => this.#syncDir(dir, left, "live", ancestry));
  }
}

export function watch(paths: string | readonly string[], options?: WatchOptions): FSWatcher {
  return new FSWatcher(paths, options);
}
