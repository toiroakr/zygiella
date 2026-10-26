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
  /** Skip EACCES and EPERM silently instead of emitting `error`. Default: false. */
  ignorePermissionErrors?: boolean;
  /** Hold add / change back until the file's size and mtime have been stable for `stabilityThreshold` ms. */
  awaitWriteFinish?: boolean | { stabilityThreshold?: number; pollInterval?: number };
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
  timer?: NodeJS.Timeout;
}

const QUIET_MS = 50;
const READY_SETTLE_MS = 50;
const ATOMIC_MS = 100;
const EDITOR_TEMP = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;

/** quiet: remember only. initial: report at once (it is what `ready` waits for). live: report once the burst of events is over. */
type Mode = "quiet" | "initial" | "live";

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
  readonly #unlinks = new Map<string, NodeJS.Timeout>();
  readonly #denied = new Set<string>();
  readonly #unwatched = new Set<string>();
  readonly #missingAtStart = new Set<string>();
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
    const awf = options.awaitWriteFinish;
    this.#settle = awf
      ? {
          stabilityThreshold: (typeof awf === "object" && awf.stabilityThreshold) || 2000,
          pollInterval: (typeof awf === "object" && awf.pollInterval) || 100,
        }
      : undefined;
    this.#ready = this.#watch(list(paths)).then((result) => {
      if (!this.#closed) this.emit("ready", result);
      return result;
    });
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
    for (const job of this.#settling.values()) clearTimeout(job.timer);
    this.#settling.clear();
    for (const timer of this.#unlinks.values()) clearTimeout(timer);
    this.#unlinks.clear();
    for (const watcher of this.#native.values()) watcher.close();
    this.#native.clear();
    this.#unwatched.clear();
    await Promise.all([...this.#queues.values()].map((q) => q.done));
  }

  #timeout(fn: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(fn, ms);
    if (!this.#persistent) timer.unref();
    return timer;
  }

  async #watch(roots: string[]): Promise<ReadyResult> {
    await this.#start(roots, this.#ignoreInitial ? "quiet" : "initial");
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
    let info = await this.#stat(root).catch((error: NodeJS.ErrnoException) => {
      this.#fail(error, root);
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
      this.#remove(root, true, undefined, true);
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
              if (ancestry.includes(real)) descend = 0;
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
    for (const path of this.#children.get(dir) ?? []) {
      if (!seen.has(path) && !uninspectable.has(path) && !this.#roots.has(path))
        this.#remove(path, true, undefined, true);
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
      this.#setEntry(path, next);
      if (next.dir) {
        if (mode !== "quiet") this.#dispatch("addDir", path);
      } else if (mode === "live" || this.#unlinks.has(path)) this.#announce("add", path);
      else if (mode === "initial") this.#dispatch("add", path);
      if (next.dir && left > 0) await this.#syncDir(path, left - 1, mode, ancestry);
      return;
    }
    if (
      !next.dir &&
      (previous.mtimeMs !== next.mtimeMs ||
        previous.size !== next.size ||
        previous.ino !== next.ino ||
        previous.link !== next.link)
    ) {
      this.#setEntry(path, next);
      if (mode !== "quiet") this.#announce("change", path);
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
    for (const [key, timer] of this.#unlinks) {
      if (!within(path, key) || !only(key) || (report && key === path)) continue;
      clearTimeout(timer);
      this.#unlinks.delete(key);
      // what is below a directory that goes away is reported before the directory is
      if (report) this.#dispatch("unlink", key);
    }
    const keys = [...this.#entries.keys()].filter((key) => within(path, key) && only(key));
    keys.sort((a, b) => b.length - a.length);
    for (const key of keys) {
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
      else if (defer && this.#atomic > 0 && key === path) this.#holdUnlink(key);
      else this.#dispatch("unlink", key);
    }
  }

  #dispatch(event: WatchEvent, path: string): void {
    if (this.#closed) return;
    // `emit` forwards the arguments as given, and the events map types them per event
    (this.emit as (event: string, ...args: unknown[]) => boolean)(event, path);
    if (!this.#closed) this.emit("all", event, path);
  }

  #takeHeld(path: string): boolean {
    const held = this.#unlinks.get(path);
    if (!held) return false;
    clearTimeout(held);
    this.#unlinks.delete(path);
    return true;
  }

  #flushUnlink(path: string): void {
    const held = this.#unlinks.get(path);
    if (!held) return;
    clearTimeout(held);
    this.#unlinks.delete(path);
    this.#dispatch("unlink", path);
  }

  #holdUnlink(path: string): void {
    const timer = this.#timeout(() => {
      this.#unlinks.delete(path);
      this.#dispatch("unlink", path);
    }, this.#atomic);
    this.#unlinks.set(path, timer);
  }

  #announce(event: "add" | "change", path: string): void {
    if (this.#takeHeld(path)) event = "change";
    const settle = this.#settle;
    const prior = this.#settling.get(path);
    clearTimeout(prior?.timer);
    const job: Settling = { event: prior?.event === "add" ? "add" : event };
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
      if (this.#settling.get(path) !== job) return;
      // gone: the directory diff reports the unlink, and needs this job to know whether the add was ever announced
      if (!info) return;
      const key = `${info.size}:${info.mtimeMs}`;
      if (key !== last) {
        last = key;
        since = Date.now();
      } else if (Date.now() - since >= settle.stabilityThreshold) {
        this.#settling.delete(path);
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
