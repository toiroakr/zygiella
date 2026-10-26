import { EventEmitter } from "node:events";
import { watch as nativeWatch, type FSWatcher as NativeWatcher, type Stats } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export type WatchEvent = "add" | "addDir" | "change" | "unlink" | "unlinkDir";

export type Ignored = RegExp | string | ((path: string) => boolean) | readonly Ignored[];

export interface WatchOptions {
  /** Do not report what already exists when a path is watched. */
  ignoreInitial?: boolean;
  /** How many directory levels below a watched directory are descended into. Default: unlimited. */
  depth?: number;
  /** Paths to skip. A skipped directory is not descended into. Receives absolute paths. */
  ignored?: Ignored;
  /** Hold add / change back until the file's size and mtime have been stable for `stabilityThreshold` ms. */
  awaitWriteFinish?: boolean | { stabilityThreshold?: number; pollInterval?: number };
}

interface Events {
  add: [path: string];
  addDir: [path: string];
  change: [path: string];
  unlink: [path: string];
  unlinkDir: [path: string];
  all: [event: WatchEvent, path: string];
  ready: [];
  error: [error: Error];
}

interface Entry {
  dir: boolean;
  mtimeMs: number;
  size: number;
  ino: number;
}

interface Settling {
  event: "add" | "change";
  timer?: NodeJS.Timeout;
}

const QUIET_MS = 50;
const READY_SETTLE_MS = 50;

/** quiet: remember only. initial: report at once (it is what `ready` waits for). live: report once the burst of events is over. */
type Mode = "quiet" | "initial" | "live";

const IGNORABLE = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

const within = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function matcher(ignored: Ignored | undefined): (path: string) => boolean {
  if (ignored === undefined) return () => false;
  if (typeof ignored === "function") return ignored;
  if (ignored instanceof RegExp) return (path) => ignored.test(path);
  if (typeof ignored === "string") {
    const target = resolve(ignored);
    return (path) => within(target, path);
  }
  const all = ignored.map(matcher);
  return (path) => all.some((m) => m(path));
}

const list = (paths: string | readonly string[]): string[] =>
  (typeof paths === "string" ? [paths] : [...paths]).map((p) => resolve(p));

export class FSWatcher extends EventEmitter<Events> {
  readonly #ignored: (path: string) => boolean;
  readonly #ignoreInitial: boolean;
  readonly #depth: number;
  readonly #settle: { stabilityThreshold: number; pollInterval: number } | undefined;

  readonly #roots = new Set<string>();
  readonly #kinds = new Map<string, "dir" | "file" | "missing">();
  readonly #probes = new Map<string, string>();
  readonly #entries = new Map<string, Entry>();
  readonly #children = new Map<string, Set<string>>();
  readonly #depthLeft = new Map<string, number>();
  readonly #native = new Map<string, NativeWatcher>();
  readonly #queues = new Map<string, { dirty: boolean; done: Promise<void> }>();
  readonly #settling = new Map<string, Settling>();
  #closed = false;

  #ready: Promise<void>;

  /**
   * Resolves once the paths last given to `watch()` or `add()` are being watched, so a change made right after it
   * is reported. The `ready` event is emitted for the paths given to `watch()` only.
   */
  get ready(): Promise<void> {
    return this.#ready;
  }

  constructor(paths: string | readonly string[], options: WatchOptions = {}) {
    super();
    this.#ignored = matcher(options.ignored);
    this.#ignoreInitial = options.ignoreInitial ?? false;
    this.#depth = options.depth ?? Infinity;
    const awf = options.awaitWriteFinish;
    this.#settle = awf
      ? {
          stabilityThreshold: (typeof awf === "object" && awf.stabilityThreshold) || 2000,
          pollInterval: (typeof awf === "object" && awf.pollInterval) || 100,
        }
      : undefined;
    this.#ready = this.#watch(list(paths)).then(() => {
      if (!this.#closed) this.emit("ready");
    });
  }

  add(paths: string | readonly string[]): this {
    this.#ready = this.#watch(list(paths));
    return this;
  }

  unwatch(paths: string | readonly string[]): this {
    for (const path of list(paths)) {
      this.#roots.delete(path);
      this.#kinds.delete(path);
      const probe = this.#probes.get(path);
      this.#probes.delete(path);
      this.#remove(path, false, (key) => ![...this.#roots].some((root) => within(root, key)));
      if (probe) this.#release(probe);
      const parent = dirname(path);
      if (parent !== path) this.#release(parent);
    }
    return this;
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#settling.values()) clearTimeout(job.timer);
    this.#settling.clear();
    for (const watcher of this.#native.values()) watcher.close();
    this.#native.clear();
    await Promise.all([...this.#queues.values()].map((q) => q.done));
  }

  async #watch(roots: string[]): Promise<void> {
    await this.#start(roots, this.#ignoreInitial ? "quiet" : "initial");
    // fs.watch returns before the OS starts delivering (FSEvents on macOS): a change made in that gap is never reported
    await new Promise<void>((done) => setTimeout(done, READY_SETTLE_MS));
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
          await fn().catch((error: NodeJS.ErrnoException) => {
            if (!this.#closed && !IGNORABLE.has(error.code ?? "")) this.emit("error", error);
          });
        } while (queue.dirty && !this.#closed);
      } finally {
        this.#queues.delete(key);
      }
    })();
    return queue.done;
  }

  async #syncRoot(root: string, mode: Mode): Promise<void> {
    if (this.#closed || !this.#roots.has(root)) return;
    if (this.#ignored(root)) return;
    const previousProbe = this.#probes.get(root);
    const info = await stat(root).catch(() => undefined);
    if (this.#closed || !this.#roots.has(root)) return;

    if (!info) {
      this.#remove(root, true);
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
      // the root may have been created between the stat above and the watch being attached
      if (
        await stat(root).then(
          () => true,
          () => false,
        )
      )
        await this.#syncRoot(root, "live");
      return;
    }

    this.#probes.delete(root);
    if (info.isDirectory()) {
      this.#kinds.set(root, "dir");
      this.#ensureNative(root);
      await this.#visit(root, info, 0, mode);
      await this.#syncDir(root, this.#depth, mode);
    } else {
      this.#kinds.set(root, "file");
      this.#ensureNative(dirname(root));
      await this.#visit(root, info, 0, mode);
    }
    if (previousProbe) this.#release(previousProbe);
  }

  async #syncDir(dir: string, left: number, mode: Mode): Promise<void> {
    if (this.#closed || ![...this.#roots].some((root) => within(root, dir))) return;
    // attach the watcher before reading, so nothing that changes during the scan is lost
    this.#depthLeft.set(dir, left);
    this.#ensureNative(dir);
    const names = await readdir(dir).catch(() => undefined);
    if (!names || this.#closed) return;

    const seen = new Set<string>();
    await Promise.all(
      names.map(async (name) => {
        const path = join(dir, name);
        if (this.#ignored(path)) return;
        const own = await lstat(path).catch(() => undefined);
        if (!own) return;
        // a link is reported as what it points at, but never descended into: a link back to an ancestor would loop forever
        const link = own.isSymbolicLink();
        const info = link ? await stat(path).catch(() => undefined) : own;
        if (!info) return;
        seen.add(path);
        await this.#visit(path, info, link ? 0 : left, mode);
      }),
    );
    for (const path of this.#children.get(dir) ?? []) {
      if (!seen.has(path) && !this.#roots.has(path)) this.#remove(path, true);
    }
  }

  async #visit(path: string, info: Stats, left: number, mode: Mode): Promise<void> {
    const next: Entry = {
      dir: info.isDirectory(),
      mtimeMs: info.mtimeMs,
      size: info.size,
      ino: info.ino,
    };
    let previous = this.#entries.get(path);
    if (previous && previous.dir !== next.dir) {
      this.#remove(path, true);
      previous = undefined;
    }
    if (!previous) {
      this.#setEntry(path, next);
      if (mode !== "quiet") {
        if (next.dir || mode === "initial") this.#dispatch(next.dir ? "addDir" : "add", path);
        else this.#announce("add", path);
      }
      if (next.dir && left > 0) await this.#syncDir(path, left - 1, mode);
      return;
    }
    if (
      !next.dir &&
      (previous.mtimeMs !== next.mtimeMs ||
        previous.size !== next.size ||
        previous.ino !== next.ino)
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

  /** Forgets `path` and everything below it, deepest first, optionally reporting each as unlink / unlinkDir. */
  #remove(path: string, report: boolean, only: (key: string) => boolean = () => true): void {
    const keys = [...this.#entries.keys()].filter((key) => within(path, key) && only(key));
    keys.sort((a, b) => b.length - a.length);
    for (const key of keys) {
      const entry = this.#entries.get(key)!;
      const job = this.#settling.get(key);
      clearTimeout(job?.timer);
      this.#settling.delete(key);
      this.#entries.delete(key);
      this.#children.get(dirname(key))?.delete(key);
      this.#children.delete(key);
      if (entry.dir) {
        this.#depthLeft.delete(key);
        this.#release(key);
      }
      // an add that never settled was never reported, so there is nothing to take back
      if (report && job?.event !== "add") this.#dispatch(entry.dir ? "unlinkDir" : "unlink", key);
    }
  }

  #dispatch(event: WatchEvent, path: string): void {
    if (this.#closed) return;
    // `emit` forwards the arguments as given, and the events map types them per event
    (this.emit as (event: string, ...args: unknown[]) => boolean)(event, path);
    this.emit("all", event, path);
  }

  #announce(event: "add" | "change", path: string): void {
    const settle = this.#settle;
    const prior = this.#settling.get(path);
    clearTimeout(prior?.timer);
    const job: Settling = { event: prior?.event === "add" ? "add" : event };
    this.#settling.set(path, job);
    if (!settle) {
      // Linux reports a write as truncate then write, and a new file as create then write: one report for the burst
      job.timer = setTimeout(() => {
        this.#settling.delete(path);
        this.#dispatch(job.event, path);
      }, QUIET_MS);
      return;
    }
    let last: string | undefined;
    let since = Date.now();
    const poll = async (): Promise<void> => {
      const info = await stat(path).catch(() => undefined);
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
      job.timer = setTimeout(poll, settle.pollInterval);
    };
    job.timer = setTimeout(poll, settle.pollInterval);
  }

  #ensureNative(dir: string): void {
    if (this.#closed || this.#native.has(dir)) return;
    try {
      const watcher = nativeWatch(dir);
      watcher.on("change", () => this.#onNative(dir));
      watcher.on("error", (error) => {
        // the directory itself went away; its parent's or the root's own sync reports it
        this.#native.delete(dir);
        watcher.close();
        this.#onNative(dir);
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!IGNORABLE.has(code)) this.emit("error", error);
      });
      this.#native.set(dir, watcher);
    } catch (error) {
      if (!IGNORABLE.has((error as NodeJS.ErrnoException).code ?? ""))
        this.emit("error", error as Error);
    }
  }

  #release(dir: string): void {
    const needed =
      this.#depthLeft.has(dir) ||
      [...this.#probes.values()].includes(dir) ||
      [...this.#roots].some((root) => this.#kinds.get(root) === "file" && dirname(root) === dir);
    if (needed) return;
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
    if (left !== undefined && !this.#roots.has(dir))
      void this.#serial(`dir:${dir}`, () => this.#syncDir(dir, left, "live"));
  }
}

export function watch(paths: string | readonly string[], options?: WatchOptions): FSWatcher {
  return new FSWatcher(paths, options);
}
