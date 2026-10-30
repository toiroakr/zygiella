import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { trackMoves } from "./moves.ts";
import { pendingEvents } from "./pending.ts";
import { readsInFlight } from "./reads.ts";
import { DENIED, VANISHED, nativeWatches, nearestDirectory } from "./native.ts";
import { recorded, seedEntries, toSnapshot } from "./snapshot.ts";
import { list, within } from "./match.ts";
import { resolveOptions } from "./options.ts";
import type {
  AddDetails,
  Entry,
  Events,
  ReadyResult,
  Snapshot,
  SnapshotEntry,
  WatchEvent,
  WatchOptions,
} from "./types.ts";

export type {
  AddDetails,
  Ignored,
  ReadyResult,
  Snapshot,
  SnapshotEntry,
  WatchEvent,
  WatchOptions,
} from "./types.ts";

const READY_SETTLE_MS = 50;
// above this many entries a native event is trusted for the name it carries instead of reading the whole directory
const LARGE_DIRECTORY = 1000;
// such a directory is read whole once its events have stopped for this long, so an event that was lost is repaired
const AUDIT_QUIET_MS = 1000;
const differs = (previous: Entry, next: Entry): boolean =>
  previous.mtimeMs !== next.mtimeMs ||
  previous.size !== next.size ||
  previous.ino !== next.ino ||
  previous.link !== next.link;
// a file system that reports no inode number (0) cannot tell a replaced directory from the same one
const replaced = (previous: Entry, next: Entry): boolean =>
  previous.ino !== 0 && next.ino !== 0 && previous.ino !== next.ino;
const isTrue = (): boolean => true;
const isFalse = (): boolean => false;

/**
 * quiet: remember only. initial: report at once (it is what `ready` waits for). seed: initial against a snapshot, so
 * `change` and `unlink` come at once too. live: report once the burst of events is over.
 */
type Mode = "quiet" | "initial" | "seed" | "live";

/**
 * What `watch()` returns: an `EventEmitter` with the events of `WatchEvent`, `all`, `ready` and `error`.
 */
export interface FSWatcher extends EventEmitter<Events> {
  /**
   * Resolves once the paths last given to `watch()` or `add()` are being watched, so a change made right after it
   * is reported. It resolves to the paths of that call that did not exist. The `ready` event is emitted for the
   * paths given to `watch()` only.
   */
  readonly ready: Promise<ReadyResult>;
  /**
   * Directories that are read but have no native watch, because `fs.watch` threw (`ENOSPC`, `EMFILE`) or the
   * watcher reported an error. Changes below them are missed until `rescan()` reads them, and it also tries to
   * watch them again. Where a whole tree is one native watch (macOS), the watched path stands for the tree.
   */
  readonly unwatched: readonly string[];
  /**
   * The state to start the next run from (`since`): what has been reported so far. A file whose `add` is still
   * waiting is left out, so the next run reports it; a `change` that is waiting, or an `unlink` held back for
   * `atomic`, is recorded as it was before, so the next run reports that too.
   */
  snapshot(): Snapshot;
  /**
   * The directories that are read, as absolute paths, each with the sorted names of what is watched directly in
   * it: files and directories, but not what `ignored` skips. A directory at the `depth` limit is a name in its
   * parent but not a key. The directory of each path given to `watch()` or `add()` is a key too, so a file given
   * directly is listed under its directory. Empty after `close()`.
   */
  getWatched(): Record<string, string[]>;
  add(paths: string | readonly string[]): this;
  unwatch(paths: string | readonly string[]): this;
  /**
   * Reads every watched root and every directory descended into again, and reports what differs from the last
   * time. Resolves once that is read; add / change are reported after their usual wait.
   */
  rescan(): Promise<void>;
  close(): Promise<void>;
}

export function watch(paths: string | readonly string[], options: WatchOptions = {}): FSWatcher {
  const emitter = new EventEmitter<Events>();
  const {
    ignored,
    atomicMs,
    ignoreInitial,
    maxDepth,
    followSymlinks,
    ignorePermissionErrors,
    persistent,
    rescanInterval,
    settle,
  } = resolveOptions(options);

  const watchedRoots = new Set<string>();
  const kinds = new Map<string, "dir" | "file" | "missing">();
  const probes = new Map<string, string>();
  const rereads = new Set<NodeJS.Timeout>();
  const entries = new Map<string, Entry>();
  const children = new Map<string, Set<string>>();
  const depthLeft = new Map<string, number>();
  /** Real paths of the directories from the watched root down to each directory, the directory's own last. */
  const ancestries = new Map<string, readonly string[]>();
  const queues = new Map<string, { dirty: boolean; done: Promise<void> }>();
  const denied = new Set<string>();
  const missingAtStart = new Set<string>();
  /** The real path of each directory root that has been read, which is what its tree watch reports below it. */
  const realRoots = new Map<string, string>();
  let retryLimits = false;
  const audits = new Map<string, NodeJS.Timeout>();
  /** For each directory the full reads going through it, each with the paths a named entry read recorded meanwhile. */
  const scanning = new Map<string, Set<Set<string>>>();
  /** The directory reads that are going on: a first report of an add waits for those that are going on when it is announced (`after`). */
  const reading = readsInFlight();
  /**
   * The reads of each path that have not returned yet. Marking them as stale beats comparing a count taken before and
   * after: a count has to be dropped with the path and then reads again the value that a read still in flight took.
   */
  const reads = new Map<string, Set<{ stale: boolean }>>();
  let rescanTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let ready: Promise<ReadyResult>;

  const natives = nativeWatches({
    persistent,
    needed,
    onChange: onNative,
    onLost: () => {
      if (!closed) void serial("rescan", () => rescanOnce());
    },
    onError: fail,
  });
  const moves = trackMoves();
  const pending = pendingEvents({
    atomic: atomicMs,
    settle,
    followSymlinks,
    timeout,
    dispatch,
    stat: followStat,
    settled,
    // a large directory reports from named reads on purpose, so its full read is not waited for
    after: (path) => (isLarge(dirname(path)) ? undefined : reading.all()),
  });

  /**
   * The state to start the next run from (`since`): what has been reported so far. A file whose `add` is still
   * waiting is left out, so the next run reports it; a `change` that is waiting, or an `unlink` held back for
   * `atomic`, is recorded as it was before, so the next run reports that too.
   */
  function snapshot(): Snapshot {
    const recordedEntries: SnapshotEntry[] = [];
    for (const [path, current] of entries) {
      const before = pending.baseline(path, current);
      if (before) recordedEntries.push(recorded(path, before));
    }
    for (const [path, entry] of pending.heldEntries()) recordedEntries.push(recorded(path, entry));
    return toSnapshot(recordedEntries);
  }

  function getWatched(): Record<string, string[]> {
    const watched: Record<string, string[]> = {};
    if (closed) return watched;
    const dirs = new Set(depthLeft.keys());
    for (const root of watchedRoots) dirs.add(dirname(root));
    for (const dir of [...dirs].sort()) watched[dir] = [];
    for (const path of entries.keys()) {
      const dir = dirname(path);
      if (path !== dir) watched[dir]?.push(basename(path));
    }
    for (const names of Object.values(watched)) names.sort();
    return watched;
  }

  /** The file settled at this size and mtime: the entry may not know yet, as no native event reads it again. */
  function settled(path: string, info: Stats, link: string | undefined): Entry | undefined {
    const entry = entries.get(path);
    if (!entry || entry.dir) return undefined;
    staleReads(path);
    const next: Entry = {
      ...entry,
      mtimeMs: info.mtimeMs,
      size: info.size,
      ino: info.ino,
      link: info.isSymbolicLink() ? (link ?? entry.link) : undefined,
    };
    entries.set(path, next);
    return next;
  }

  function staleReads(path: string): void {
    for (const read of reads.get(path) ?? []) read.stale = true;
  }

  /**
   * Reads again when `settled` recorded the path, or `remove` forgot it, while the read was in flight: the result
   * may be older than the entry and would put it back. Dropping it instead could lose a newer state whose native
   * event was merged into the one that started this read. The mark is not kept until `visit()` uses the result:
   * nothing but promise callbacks sits between the two, so `settled()`, which runs from a timer or an I/O callback,
   * cannot run in between.
   */
  async function unsettled<T>(path: string, read: () => Promise<T>): Promise<T> {
    for (;;) {
      const mark = { stale: false };
      let marks = reads.get(path);
      if (!marks) reads.set(path, (marks = new Set()));
      marks.add(mark);
      try {
        const result = await read();
        if (!mark.stale) return result;
      } catch (error) {
        if (!mark.stale) throw error;
      } finally {
        marks.delete(mark);
        if (!marks.size && reads.get(path) === marks) reads.delete(path);
      }
    }
  }

  /** Remembers what `since` holds for the watched roots, so the first scan reports only the difference. */
  function seed(since: Snapshot | null | undefined, roots: string[]): void {
    for (const { path, dir, mtimeMs, size, ino, link } of seedEntries(
      since,
      roots,
      maxDepth,
      ignored.byPath,
    ))
      setEntry(path, { dir, mtimeMs, size, ino, link });
  }

  function add(paths: string | readonly string[]): FSWatcher {
    ready = begin(list(paths));
    return watcher;
  }

  function unwatch(paths: string | readonly string[]): FSWatcher {
    for (const path of list(paths)) forget(path);
    return watcher;
  }

  function forget(path: string): void {
    watchedRoots.delete(path);
    realRoots.delete(path);
    missingAtStart.delete(path);
    for (const key of denied) if (within(path, key)) denied.delete(key);
    kinds.delete(path);
    natives.releaseTree(path);
    const probe = probes.get(path);
    probes.delete(path);
    remove(path, false, (key) => ![...watchedRoots].some((root) => within(root, key)));
    if (probe) natives.release(probe);
    // a directory whose watch failed has no entry, so remove never released it
    for (const key of natives.unwatched()) if (within(path, key)) natives.release(key);
    const parent = dirname(path);
    if (parent !== path) {
      natives.release(parent);
      // release keeps a directory that is still tracked, but a tree may report it now that no file waits for it
      const ancestry = ancestries.get(parent);
      if (ancestry && physical(parent, ancestry)) natives.covered(parent, waitedFor(parent));
    }
    // what stays tracked below the path may have been reported by the tree watch that is closed now, as the directory
    // behind a link that was a root of its own: it needs a watch of its own again unless another tree reports it. So
    // do the directories that a watched file or a path that does not exist yet is waited for through. Each is tried
    // once, and one whose watch failed stays listed and is not tried again by this.
    const again = new Set(probes.values());
    for (const root of watchedRoots) if (kinds.get(root) === "file") again.add(dirname(root));
    for (const [dir, ancestry] of ancestries)
      if (within(path, dir) && depthLeft.has(dir) && !physical(dir, ancestry)) again.add(dir);
    const failed = new Set(natives.unwatched());
    for (const dir of again) if (!failed.has(dir)) natives.ensure(dir);
  }

  /**
   * Reads every watched root and every directory descended into again, and reports what differs from the last
   * time. Resolves once that is read; add / change are reported after their usual wait.
   */
  async function rescan(): Promise<void> {
    if (closed) return;
    retryLimits = true;
    // a call made while a rescan runs makes it run once more afterwards, so two rescans never read at the same time
    await serial("rescan", () => rescanOnce());
  }

  async function rescanOnce(): Promise<void> {
    // a limit that stopped a watch may be gone by now, but only a call of rescan() lets the watches try again, not the
    // read that a tree watch asks for after it lost track
    if (retryLimits) natives.retry();
    retryLimits = false;
    await readAgain([...watchedRoots], true);
  }

  /** Reads the roots and every directory below them that was descended into, again; `all` says the roots are all of them. */
  async function readAgain(roots: readonly string[], all = false): Promise<void> {
    await Promise.all(roots.map((root) => serial(`root:${root}`, () => syncRoot(root, "live"))));
    // a read can drop a directory or change what lies below it, so shallow directories go first and each one is
    // looked up again when its turn comes
    const levels = new Map<number, string[]>();
    for (const dir of depthLeft.keys()) {
      if (!all && !roots.some((root) => within(root, dir))) continue;
      const depth = dir.split(sep).length;
      const level = levels.get(depth);
      if (level) level.push(dir);
      else levels.set(depth, [dir]);
    }
    for (const depth of [...levels.keys()].sort((a, b) => a - b)) {
      await Promise.all(
        levels.get(depth)!.map((dir) => {
          const left = depthLeft.get(dir);
          const ancestry = ancestries.get(dir);
          return left !== undefined && ancestry && !watchedRoots.has(dir)
            ? serial(`dir:${dir}`, () => syncDir(dir, left, "live", ancestry))
            : undefined;
        }),
      );
    }
  }

  async function close(): Promise<void> {
    closed = true;
    clearTimeout(rescanTimer);
    for (const timer of audits.values()) clearTimeout(timer);
    audits.clear();
    for (const timer of rereads) clearTimeout(timer);
    rereads.clear();
    pending.close(entries);
    natives.close();
    await Promise.all([...queues.values()].map((q) => q.done));
  }

  function scheduleRescan(): void {
    if (closed || rescanInterval === 0) return;
    rescanTimer = timeout(() => {
      void watcher.rescan().finally(() => scheduleRescan());
    }, rescanInterval);
  }

  function timeout(fn: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(fn, ms);
    if (!persistent) timer.unref();
    return timer;
  }

  async function begin(roots: string[], since = false): Promise<ReadyResult> {
    await start(roots, since ? "seed" : ignoreInitial ? "quiet" : "initial");
    const missing = [...new Set(roots)].filter((root) => missingAtStart.has(root));
    // not unref'd: a caller awaiting `ready` would otherwise see the process exit before it resolves (exit code 13)
    // fs.watch returns before the OS starts delivering (FSEvents on macOS): a change made in that gap is never reported
    await new Promise<void>((done) => setTimeout(done, READY_SETTLE_MS));
    return { missing };
  }

  function start(roots: string[], mode: Mode): Promise<void> {
    for (const root of roots) watchedRoots.add(root);
    return Promise.all(
      roots.map((root) => serial(`root:${root}`, () => syncRoot(root, mode))),
    ).then(() => undefined);
  }

  /** Runs `fn` for `key` one at a time; a request made while it runs makes it run once more afterwards. */
  function serial(key: string, fn: () => Promise<void>): Promise<void> {
    const running = queues.get(key);
    if (running) {
      running.dirty = true;
      return running.done;
    }
    const queue = { dirty: false, done: Promise.resolve() };
    queues.set(key, queue);
    queue.done = (async () => {
      try {
        do {
          queue.dirty = false;
          await fn().catch((error: NodeJS.ErrnoException) => fail(error, key));
        } while (queue.dirty && !closed);
      } finally {
        queues.delete(key);
      }
    })();
    return queue.done;
  }

  async function syncRoot(root: string, mode: Mode): Promise<void> {
    if (closed || !watchedRoots.has(root)) return;
    if (ignored.byPath(root)) return;
    const previousProbe = probes.get(root);
    const previousParent = kinds.get(root) === "file" ? dirname(root) : undefined;
    if (mode !== "live") missingAtStart.delete(root);
    const { info, link, real, unreadable } = await statRoot(root, mode);
    if (closed || !watchedRoots.has(root)) {
      natives.release(root);
      return;
    }
    if (info && !info.isDirectory()) denied.delete(root);

    if (!info) {
      await watchMissing(root, mode, unreadable, previousProbe);
      if (previousParent) natives.release(previousParent);
      // the root may have been created between the stat above and the watch being attached
      if (await followStat(root).then(isTrue, isFalse)) await syncRoot(root, "live");
      return;
    }

    if (!entries.has(root) && ignored.byStats?.(root, info)) watchSkipped(root, info);
    else {
      await scanRoot(root, info, link, real, mode);
      if (previousProbe && mode === "live") readAgainOnceDelivering(root);
    }
    if (previousProbe) natives.release(previousProbe);
    if (previousParent) natives.release(previousParent);
  }

  /**
   * `fs.watch` of a root that appeared returns before the OS delivers (FSEvents on macOS), as it does at `ready`, so
   * a file made right after the first read of the root is never reported: one more read, when delivery has started.
   */
  function readAgainOnceDelivering(root: string): void {
    // a scan that was still reading when close() was called must not schedule anything
    if (closed) return;
    const timer = timeout(() => {
      rereads.delete(timer);
      if (!closed && watchedRoots.has(root)) void readAgain([root]);
    }, READY_SETTLE_MS);
    rereads.add(timer);
  }

  /** A root skipped by its stats is watched all the same, so that it is read again when its stats may have changed. */
  function watchSkipped(root: string, info: Stats): void {
    kinds.set(root, info.isDirectory() ? "dir" : "file");
    // a directory has no entry to keep its watch while it is skipped, so the probe does, and unwatch() releases it
    if (info.isDirectory()) probes.set(root, root);
    else probes.delete(root);
    natives.ensure(info.isDirectory() ? root : dirname(root));
  }

  function attachRoot(root: string): void {
    // a finite depth leaves most of the tree unwatched, which one watch for the whole tree cannot do
    if (maxDepth !== Infinity || !natives.ensureTree(root)) natives.ensure(root);
  }

  async function scanRoot(
    root: string,
    info: Stats,
    link: string | undefined,
    real: string,
    mode: Mode,
  ): Promise<void> {
    probes.delete(root);
    if (!info.isDirectory()) {
      kinds.set(root, "file");
      natives.ensure(dirname(root));
      await visit(root, info, 0, mode, [], link);
      return;
    }
    kinds.set(root, "dir");
    attachRoot(root);
    realRoots.set(root, real);
    await visit(root, info, 0, mode, [], real);
    // a root that was replaced was removed by `visit`, which closed its tree watch
    if (!closed && watchedRoots.has(root)) attachRoot(root);
    await syncDir(root, maxDepth, mode, [real]);
  }

  async function statRoot(
    root: string,
    mode: Mode,
  ): Promise<{
    info: Stats | undefined;
    link: string | undefined;
    real: string;
    unreadable: boolean;
  }> {
    let unreadable = false;
    const read = await unsettled(root, async () => {
      const info = await followStat(root);
      const link =
        !followSymlinks && info.isSymbolicLink()
          ? await readlink(root).catch(() => undefined)
          : undefined;
      if (info.isDirectory()) {
        kinds.set(root, "dir");
        attachRoot(root);
      }
      const real = info.isDirectory() ? await realpath(root).catch(() => root) : root;
      return { info, link, real };
    }).catch((error: NodeJS.ErrnoException) => {
      fail(error, root);
      unreadable = !VANISHED.has(error.code ?? "");
      if (mode !== "live" && VANISHED.has(error.code ?? "")) missingAtStart.add(root);
      return undefined;
    });
    const gone = !!read && !followSymlinks && read.info.isSymbolicLink() && read.link === undefined;
    return {
      info: gone ? undefined : read?.info,
      link: read?.link,
      real: read?.real ?? root,
      unreadable,
    };
  }

  /** Watches the nearest directory that exists, so that the root is seen when it is created. */
  async function watchMissing(
    root: string,
    mode: Mode,
    unreadable: boolean,
    previousProbe: string | undefined,
  ): Promise<void> {
    // a root that cannot be inspected is not known to be gone, and neither is what is below it
    if (!unreadable) remove(root, true, undefined, mode !== "seed");
    kinds.set(root, "missing");
    // a deeper folder may be created while the watcher is being attached, and would then never be seen
    let ancestor = await nearestDirectory(root);
    const attached = new Set<string>();
    for (;;) {
      probes.set(root, ancestor);
      natives.ensure(ancestor);
      attached.add(ancestor);
      const again = await nearestDirectory(root);
      if (again === ancestor) break;
      ancestor = again;
    }
    if (previousProbe) attached.add(previousProbe);
    attached.delete(ancestor);
    for (const stale of attached) natives.release(stale);
  }

  /**
   * Forgets what a snapshot put below a link back to an ancestor, which is never descended into: nothing would scan
   * it, so it would stay in the baseline after the file is gone. What a watched root at or below that path covers is
   * scanned through that root and keeps its entries, and so do the directories between that path and the root.
   */
  function forgetBelow(path: string): void {
    if (!children.get(path)?.size) return;
    remove(
      path,
      false,
      (key) =>
        key !== path &&
        ![...watchedRoots].some(
          (root) => within(path, root) && (within(root, key) || within(key, root)),
        ),
    );
  }

  function followStat(path: string): Promise<Stats> {
    return followSymlinks ? stat(path) : lstat(path);
  }

  async function syncDir(
    dir: string,
    left: number,
    mode: Mode,
    ancestry: readonly string[],
  ): Promise<void> {
    // a named entry read that runs while this one lists the directory records entries the list is too early to contain
    const recorded = new Set<string>();
    let reads = scanning.get(dir);
    if (!reads) scanning.set(dir, (reads = new Set()));
    reads.add(recorded);
    const read = readDir(dir, left, mode, ancestry, recorded);
    reading.track(dir, read);
    try {
      await read;
    } finally {
      reads.delete(recorded);
      if (!reads.size && scanning.get(dir) === reads) scanning.delete(dir);
    }
  }

  async function readDir(
    dir: string,
    left: number,
    mode: Mode,
    ancestry: readonly string[],
    recorded: ReadonlySet<string>,
  ): Promise<void> {
    if (closed || ![...watchedRoots].some((root) => within(root, dir))) return;
    // attach the watcher before reading, so nothing that changes during the scan is lost
    depthLeft.set(dir, left);
    ancestries.set(dir, ancestry);
    if (physical(dir, ancestry)) natives.covered(dir, waitedFor(dir));
    else natives.ensure(dir);
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      fail(error, dir);
      return undefined;
    });
    if (!names || closed) return;
    denied.delete(dir);

    const seen = new Set<string>();
    const uninspectable = new Set<string>();
    const covered = () => [...watchedRoots].some((root) => within(root, dir));
    const examine = (path: string) =>
      syncEntry(dir, basename(path), left, mode, ancestry, seen, uninspectable);
    await Promise.all(
      names.map((name) => syncEntry(dir, name, left, mode, ancestry, seen, uninspectable)),
    );
    if (closed) return;
    const listed = new Set(names);
    // One name at a time would make a bulk removal wait for a round trip per file, and waiting for all of them before
    // removing any would leave the window open again, so each is removed as soon as its own check is done.
    await Promise.all(
      Array.from(children.get(dir) ?? [], async (path) => {
        if (
          seen.has(path) ||
          uninspectable.has(path) ||
          recorded.has(path) ||
          watchedRoots.has(path)
        )
          return;
        if (!covered() || !children.get(dir)?.has(path)) return;
        // The siblings may have taken long: a file that was missing at its read can be back and reported since then. Not
        // a directory: one that is being deleted can still be read, and keeping it would keep its native watcher open.
        if (entries.get(path)?.dir === false) {
          if ((await examine(path)) || closed) return;
          // what was true before the check may not be any more: `add()` can have made the path a root of its own
          if (watchedRoots.has(path) || !covered() || !children.get(dir)?.has(path)) return;
          // a refused read does not keep a name the listing did not have (a directory that is being deleted can refuse one),
          // but a name it had, whose first read found it missing, is not known to be gone
          if (listed.has(basename(path)) && uninspectable.has(path)) return;
        }
        remove(path, true, undefined, mode !== "seed");
      }),
    );
    if (closed) return;
    for (const path of denied) {
      if (dirname(path) === dir && !listed.has(basename(path))) denied.delete(path);
    }
  }

  /**
   * Whether a tree watch reports `dir`: it lies below a root that has one, with no link on the way, so that its real
   * path is the real path of that root followed by the same names. It is not reported behind a link.
   */
  function physical(dir: string, ancestry: readonly string[]): boolean {
    return [...watchedRoots].some(
      (root) =>
        natives.hasTree(root) &&
        within(root, dir) &&
        join(realRoots.get(root) ?? root, relative(root, dir)) === ancestry.at(-1),
    );
  }

  /** A watched file, or a path that does not exist yet, depends on the watch of `dir`. */
  function waitedFor(dir: string): boolean {
    return (
      [...probes.values()].includes(dir) ||
      [...watchedRoots].some((root) => kinds.get(root) === "file" && dirname(root) === dir)
    );
  }

  /** What one name of `dir` is now: reported through `visit`, and recorded in `seen` unless it is gone. */
  async function syncEntry(
    dir: string,
    name: string,
    left: number,
    mode: Mode,
    ancestry: readonly string[],
    seen: Set<string>,
    uninspectable: Set<string>,
  ): Promise<boolean> {
    const path = join(dir, name);
    const failed = (error: NodeJS.ErrnoException, at: string): undefined => {
      fail(error, at);
      if (!VANISHED.has(error.code ?? "")) uninspectable.add(at);
      return undefined;
    };
    const found = await inspect(path, left, mode, ancestry, failed);
    if (!found) return false;
    // an unlink listener may have unwatched the directory while the read was in flight
    if (closed || ![...watchedRoots].some((root) => within(root, dir))) return true;
    seen.add(path);
    await visit(
      path,
      found.info,
      found.descend,
      mode,
      [...ancestry, found.real],
      found.info.isDirectory() ? found.real : found.link,
    );
    return true;
  }

  /** Like `syncDir` for the one name that `fs.watch` reported, which is what keeps a huge directory from being read again. */
  async function syncName(
    dir: string,
    name: string,
    left: number,
    mode: Mode,
    ancestry: readonly string[],
  ): Promise<void> {
    if (closed || ![...watchedRoots].some((root) => within(root, dir))) return;
    const path = join(dir, name);
    const seen = new Set<string>();
    const uninspectable = new Set<string>();
    const record = () => {
      for (const recorded of scanning.get(dir) ?? []) recorded.add(path);
    };
    record();
    await syncEntry(dir, name, left, mode, ancestry, seen, uninspectable);
    record();
    if (closed || seen.has(path) || uninspectable.has(path) || watchedRoots.has(path)) return;
    if (children.get(dir)?.has(path)) remove(path, true, undefined, mode !== "seed");
  }

  interface Found {
    info: Stats;
    /** The real path of the entry, for a directory it is what `ancestry` records. */
    real: string;
    link: string | undefined;
    /** How many levels below it are descended into. */
    descend: number;
  }

  type Failed = (error: NodeJS.ErrnoException, path: string) => undefined;

  /** What a name in a directory is, or undefined when it is skipped (ignored, gone, unreadable). */
  async function inspect(
    path: string,
    left: number,
    mode: Mode,
    ancestry: readonly string[],
    failed: Failed,
  ): Promise<Found | undefined> {
    if (ignored.byPath(path)) return;
    const read = await unsettled(path, async () => {
      const own = await lstat(path);
      return {
        own,
        link: !followSymlinks && own.isSymbolicLink() ? await readlink(path) : undefined,
      };
    }).catch((error) => failed(error, path));
    if (!read) return;
    const { own } = read;
    let found: Found | undefined = {
      info: own,
      real: join(ancestry.at(-1)!, basename(path)),
      link: read.link,
      descend: left,
    };
    if (own.isSymbolicLink() && followSymlinks) {
      found = await followLink(path, found, mode, ancestry, failed);
      if (!found) return;
    }
    if (own.isSymbolicLink() || !found.info.isDirectory()) denied.delete(path);
    if (!entries.has(path) && ignored.byStats?.(path, found.info)) return;
    return found;
  }

  async function followLink(
    path: string,
    found: Found,
    mode: Mode,
    ancestry: readonly string[],
    failed: Failed,
  ): Promise<Found | undefined> {
    const target = await unsettled(path, async () => {
      const info = await stat(path);
      return { info, real: info.isDirectory() ? await realpath(path) : undefined };
    }).catch((error) => failed(error, path));
    if (!target) return;
    const { info, real } = target;
    if (!real) return { ...found, info };
    // a link to a directory already on the way down would loop forever
    if (!ancestry.includes(real)) return { ...found, info, real };
    // a link that points somewhere else than before is reported by `visit`, with what was below it
    if (mode === "seed" && entries.get(path)?.link === real) forgetBelow(path);
    return { ...found, info, real, descend: 0 };
  }

  async function visit(
    path: string,
    info: Stats,
    left: number,
    mode: Mode,
    ancestry: readonly string[] = [],
    link?: string,
  ): Promise<void> {
    // a scan that was reading when close() was called must not add what was never reported to the baseline
    if (closed) return;
    const next: Entry = {
      dir: info.isDirectory(),
      mtimeMs: info.mtimeMs,
      size: info.size,
      ino: info.ino,
      dev: info.dev,
      link,
    };
    let previous = entries.get(path);
    if (
      previous &&
      (previous.dir !== next.dir ||
        (next.dir && (previous.link !== next.link || replaced(previous, next))))
    ) {
      // a watch kept for a watched file below still follows the inode that was moved away, so it goes too
      const stale = replaced(previous, next)
        ? [...entries].filter(([key, entry]) => entry.dir && within(path, key)).map(([key]) => key)
        : [];
      remove(path, true);
      for (const key of stale) natives.release(key, true);
      previous = undefined;
    }
    if (!previous) {
      await visitNew(path, next, left, mode, ancestry);
      return;
    }
    // a directory remembered from a snapshot has not been read yet
    if (next.dir && left > 0 && !depthLeft.has(path)) await syncDir(path, left - 1, mode, ancestry);
    if (!next.dir && differs(previous, next)) {
      setEntry(path, next);
      if (mode === "seed") dispatch("change", path);
      else if (mode !== "quiet") pending.announce("change", path, previous);
    } else if (!next.dir && previous.dev === undefined) {
      // an entry seeded from a snapshot has no device, and a move of it could never be paired without one
      entries.set(path, { ...previous, dev: next.dev });
    }
  }

  async function visitNew(
    path: string,
    next: Entry,
    left: number,
    mode: Mode,
    ancestry: readonly string[],
  ): Promise<void> {
    if (next.dir) pending.flush(path);
    const from = mode === "live" ? moves.added(path, next) : undefined;
    // an unlink listener may have closed the watcher: the entry would be in the baseline without being reported
    if (closed) return;
    setEntry(path, next);
    if (next.dir) {
      if (mode !== "quiet") dispatch("addDir", path);
      if (left > 0) await syncDir(path, left - 1, mode, ancestry);
    } else if (mode === "live" || pending.isHeld(path))
      pending.announce("add", path, undefined, from);
    else if (mode !== "quiet") dispatch("add", path, from);
  }

  function setEntry(path: string, entry: Entry): void {
    entries.set(path, entry);
    const parent = dirname(path);
    let siblings = children.get(parent);
    if (!siblings) children.set(parent, (siblings = new Set()));
    siblings.add(path);
  }

  /**
   * Forgets `path` and everything below it, deepest first, optionally reporting each as unlink / unlinkDir.
   * With `defer`, the unlink of `path` itself is held back for the `atomic` window if it is a file.
   */
  function remove(
    path: string,
    report: boolean,
    only: (key: string) => boolean = () => true,
    defer = false,
  ): void {
    pending.dropHeld(path, only, report);
    const keys = [...entries.keys()].filter((key) => within(path, key) && only(key));
    keys.sort((a, b) => b.length - a.length);
    for (const key of keys) {
      // a listener closed the watcher: what is left was not reported, so it stays for the snapshot
      if (closed) break;
      const entry = entries.get(key)!;
      const job = pending.cancel(key);
      entries.delete(key);
      staleReads(key);
      denied.delete(key);
      children.get(dirname(key))?.delete(key);
      children.delete(key);
      if (entry.dir) {
        depthLeft.delete(key);
        ancestries.delete(key);
        natives.release(key);
      }
      if (!report) continue;
      // an add that never settled was never reported, so there is nothing to take back; one that was paired goes on
      // from the path it came from, so that the next add of the file names it
      if (job?.event === "add") {
        if (job.renamedFrom && !entry.dir) pairMove(job.renamedFrom, entry);
        continue;
      }
      if (entry.dir) {
        dispatch("unlinkDir", key);
        continue;
      }
      pairMove(key, entry);
      if (defer && pending.holdsUnlinks && key === path) pending.hold(key, job?.before ?? entry);
      else dispatch("unlink", key);
    }
  }

  /** The file of `entry` was removed at `from`: the add waiting at the path it appeared at names `from`, if that is still the same file. */
  function pairMove(from: string, entry: Entry): void {
    const to = moves.removed(from, entry);
    const current = to === undefined ? undefined : entries.get(to);
    // a file written since it appeared is not the file that was paired, as in `announce`
    const same =
      current?.dev === entry.dev &&
      current?.ino === entry.ino &&
      current?.size === entry.size &&
      current?.mtimeMs === entry.mtimeMs;
    if (to !== undefined && same) pending.renamed(to, from);
  }

  function dispatch(event: WatchEvent, path: string, renamedFrom?: string): void {
    if (closed) return;
    const details: AddDetails[] = renamedFrom === undefined ? [] : [{ renamedFrom }];
    // `emit` forwards the arguments as given, and the events map types them per event
    (emitter.emit as (event: string, ...args: unknown[]) => boolean)(event, path, ...details);
    if (!closed) emitter.emit("all", event, path, ...details);
  }

  /** A path that vanished is a race with whoever removed it. A permission error is reported once per path until the path reads again. */
  function fail(error: NodeJS.ErrnoException, path: string): void {
    const code = error.code ?? "";
    if (closed || VANISHED.has(code)) return;
    if (DENIED.has(code)) {
      if (ignorePermissionErrors || denied.has(path)) return;
      denied.add(path);
    }
    emitter.emit("error", error);
  }

  function needed(dir: string): boolean {
    return (
      depthLeft.has(dir) ||
      [...probes.values()].includes(dir) ||
      [...watchedRoots].some((root) => kinds.get(root) === "file" && dirname(root) === dir)
    );
  }

  const isLarge = (dir: string): boolean => (children.get(dir)?.size ?? 0) > LARGE_DIRECTORY;

  /** Reads `dir` whole once nothing has been reported for it for `AUDIT_QUIET_MS`, as an event without a name would. */
  function audit(dir: string): void {
    clearTimeout(audits.get(dir));
    audits.set(
      dir,
      timeout(() => {
        audits.delete(dir);
        onNative(dir);
      }, AUDIT_QUIET_MS),
    );
  }

  /**
   * What a read of `dir` has to wait for: the scans of the roots above it that are still going on. Such a scan reads
   * `dir` too and records what it finds, so a read that came from an event and ran meanwhile would see the entries that
   * the scan has not recorded yet as new, and report them, although `ignoreInitial` says not to.
   */
  function scansAbove(dir: string): Promise<unknown> | undefined {
    const scans: Array<Promise<unknown>> = [];
    for (const root of watchedRoots) {
      const scan = within(root, dir) ? queues.get(`root:${root}`)?.done : undefined;
      if (scan) scans.push(scan);
    }
    return scans.length > 0 ? Promise.all(scans) : undefined;
  }

  function onNative(dir: string, name?: string): void {
    if (closed) return;
    const left = depthLeft.get(dir);
    const ancestry = ancestries.get(dir);
    // a name that is a watched root is read with the root, and a root is named like itself when it is the one that
    // went away, so any other name is a hint
    if (
      name &&
      left !== undefined &&
      ancestry &&
      isLarge(dir) &&
      !(watchedRoots.has(dir) && name === basename(dir)) &&
      // a path that does not exist yet is waited for from its closest directory, and only the sync of its root moves that watch
      ![...probes.values()].includes(dir) &&
      !watchedRoots.has(join(dir, name))
    ) {
      void serial(`entry:${join(dir, name)}`, async () => {
        await scansAbove(dir);
        await syncName(dir, name, left, "live", ancestry);
      });
      audit(dir);
      return;
    }
    for (const root of watchedRoots) {
      const kind = kinds.get(root);
      const affected =
        kind === "dir"
          ? root === dir
          : kind === "file"
            ? dirname(root) === dir
            : probes.get(root) === dir;
      if (affected) void serial(`root:${root}`, () => syncRoot(root, "live"));
    }
    if (left !== undefined && ancestry && !watchedRoots.has(dir))
      void serial(`dir:${dir}`, async () => {
        await scansAbove(dir);
        await syncDir(dir, left, "live", ancestry);
      });
  }
  const watcher = Object.defineProperties(emitter, {
    ready: { get: () => ready, configurable: true },
    unwatched: { get: () => natives.unwatched(), configurable: true },
    snapshot: { value: snapshot, writable: true, configurable: true },
    getWatched: { value: getWatched, writable: true, configurable: true },
    add: { value: add, writable: true, configurable: true },
    unwatch: { value: unwatch, writable: true, configurable: true },
    rescan: { value: rescan, writable: true, configurable: true },
    close: { value: close, writable: true, configurable: true },
  }) as unknown as FSWatcher;

  const given = list(paths);
  seed(options.since, given);
  ready = begin(given, options.since !== undefined).then((result) => {
    if (!closed) emitter.emit("ready", result);
    scheduleRescan();
    return result;
  });
  return watcher;
}
